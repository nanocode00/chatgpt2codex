//! F4-C2: actual Windows filesystem handover/recovery using fake files.
//! Test-only; this module is NEVER linked into the shipped Tauri application.
//! No caller-provided paths, ports, PIDs, credentials, HOME or OAuth.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use std::os::windows::fs::MetadataExt;

const ORIGINAL: [(&str, &[u8]); 2] = [
    ("owner-token.json", b"not-a-token: synthetic original verifier"),
    ("oauth.json", b"not-an-oauth-token: synthetic original"),
];
const REPLACEMENT: [(&str, &[u8]); 2] = [
    ("owner-token.json", b"not-a-token: synthetic replacement verifier"),
    ("oauth.json", b"not-an-oauth-token: synthetic replacement"),
];
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Phase {
    Staged, OldMoved, Promoted, RollbackPending, RolledBack,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    version: u8,
    sequence: u32,
    phase: Phase,
}
#[derive(Clone, Copy)]
enum Fault {
    AfterStage, AfterOldRename, AfterOldCheckpoint,
    AfterPromotionRename, AfterPromotionCheckpoint, NoFault,
}
struct Isolated {
    root: PathBuf,
}
impl Isolated {
    fn new() -> Option<Self> {
        if std::env::var("GITHUB_ACTIONS").ok().as_deref() != Some("true")
            || std::env::var("CI").ok().as_deref() != Some("true")
            || std::env::var("C2C_F4C2_E2E").ok().as_deref() != Some("true")
        {
            return None;
        }
        let base = PathBuf::from(std::env::var_os("RUNNER_TEMP")?);
        require_directory(&base).expect("must use a normal Windows runner temp directory");
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        // Windows wall-clock ticks can repeat across parallel test threads.
        // An atomic sequence + create_dir (CREATE_NEW semantics) avoids
        // sharing a fixture root; never reuse or delete a colliding directory.
        let root = (0..16).find_map(|_| {
            let id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let candidate = base.join(format!("c2c-f4c2-{}-{stamp}-{id}", std::process::id()));
            match fs::create_dir(&candidate) {
                Ok(()) => Some(candidate),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => None,
                Err(error) => panic!("cannot create disposable fixture directory: {error}"),
            }
        }).expect("could not allocate an exclusive disposable fixture directory");
        fs::create_dir(root.join("live")).unwrap();
        write_group(&root.join("live"), &ORIGINAL).unwrap();
        fs::create_dir(root.join("journal")).unwrap();
        Some(Self { root })
    }
}

#[test]
fn parallel_fixtures_never_share_a_windows_temporary_directory() {
    let Some(_guard) = Isolated::new() else { return };
    let handles: Vec<_> = (0..12).map(|_| std::thread::spawn(|| {
        let fixture = Isolated::new().expect("CI fixture gating changed");
        require_directory(&fixture.root).unwrap();
        fixture
    })).collect();
    let fixtures: Vec<_> = handles.into_iter()
        .map(|handle| handle.join().expect("fixture thread panicked")).collect();
    let roots: std::collections::HashSet<_> = fixtures.iter()
        .map(|fixture| &fixture.root).collect();
    assert_eq!(roots.len(), fixtures.len(), "parallel fixtures must have distinct roots");
    for fixture in &fixtures {
        assert!(matches_group(&fixture.root.join("live"), &ORIGINAL));
    }
}
impl Drop for Isolated {
    fn drop(&mut self) {
        // Only a newly created, uniquely named runner temp folder.
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn require_directory(path: &Path) -> Result<(), &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "missing directory")?;
    if !meta.is_dir() || meta.file_type().is_symlink()
        || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err("directory is not an ordinary directory");
    }
    Ok(())
}
fn require_regular_file(path: &Path) -> Result<(), &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "missing file")?;
    if !meta.is_file() || meta.len() > 1024
        || meta.file_type().is_symlink()
        || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err("file is not an ordinary bounded file");
    }
    Ok(())
}
fn safe_root(root: &Path) -> Result<(), &'static str> {
    require_directory(root)?;
    require_directory(&root.join("journal"))?;
    for directory in ["live", "stage", "rollback", "quarantine"] {
        let candidate = root.join(directory);
        if fs::symlink_metadata(&candidate).is_ok() { require_directory(&candidate)?; }
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}
fn write_group(path: &Path, content: &[(&str, &[u8]); 2]) -> Result<(), &'static str> {
    require_directory(path)?;
    for (name, bytes) in content {
        let mut file = OpenOptions::new().write(true).create_new(true)
            .open(path.join(name)).map_err(|_| "fixture file already exists")?;
        file.write_all(bytes).and_then(|_| file.sync_all())
            .map_err(|_| "fixture file write or sync failed")?;
    }
    Ok(())
}
fn matches_group(path: &Path, expected: &[(&str, &[u8]); 2]) -> bool {
    if require_directory(path).is_err() { return false; }
    let Ok(entries) = fs::read_dir(path) else { return false; };
    if entries.count() != expected.len() { return false; }
    expected.iter().all(|(name, bytes)| {
        let p = path.join(name);
        require_regular_file(&p).is_ok()
            && fs::read(&p).map(|actual| digest(&actual) == digest(bytes)).unwrap_or(false)
    })
}
fn valid_step(previous: Option<Phase>, next: Phase) -> bool {
    matches!((previous, next),
        (None, Phase::Staged)
        | (Some(Phase::Staged), Phase::OldMoved)
        | (Some(Phase::OldMoved), Phase::Promoted)
        | (Some(Phase::RollbackPending), Phase::RolledBack)
    ) || (next == Phase::RollbackPending &&
        matches!(previous, Some(Phase::Staged | Phase::OldMoved | Phase::Promoted)))
}
fn read_journal(root: &Path) -> Result<(usize, Option<Phase>), &'static str> {
    safe_root(root)?;
    let mut files: Vec<_> = fs::read_dir(root.join("journal"))
        .map_err(|_| "journal unreadable")?
        .map(|entry| entry.map(|v| v.path()).map_err(|_| "entry unreadable"))
        .collect::<Result<_, _>>()?;
    files.sort();
    if files.len() > 12 { return Err("too many checkpoint files"); }
    let mut last = None;
    for (i, path) in files.iter().enumerate() {
        let name = format!("{i:04}.json");
        if path.file_name().and_then(|v| v.to_str()) != Some(name.as_str()) {
            return Err("journal sequence gap or foreign file");
        }
        require_regular_file(path)?;
        let data = fs::read(path).map_err(|_| "journal read failed")?;
        let entry: Entry = serde_json::from_slice(&data).map_err(|_| "partial or forged journal")?;
        if entry.version != 1 || entry.sequence != i as u32 || !valid_step(last, entry.phase) {
            return Err("invalid journal state");
        }
        last = Some(entry.phase);
    }
    Ok((files.len(), last))
}
fn append(root: &Path, phase: Phase) -> Result<(), &'static str> {
    let (count, old) = read_journal(root)?;
    if !valid_step(old, phase) { return Err("invalid state transition"); }
    let data = serde_json::to_vec(&Entry { version: 1, sequence: count as u32, phase })
        .map_err(|_| "serialization failure")?;
    let path = root.join("journal").join(format!("{count:04}.json"));
    let mut f = OpenOptions::new().create_new(true).write(true)
        .open(path).map_err(|_| "checkpoint exists")?;
    f.write_all(&data).and_then(|_| f.sync_all()).map_err(|_| "checkpoint sync failed")
}
fn stage_and_switch(root: &Path, fault: Fault) -> Result<(), &'static str> {
    if read_journal(root)?.1.is_some() || !matches_group(&root.join("live"), &ORIGINAL) {
        return Err("original fixture is not clean");
    }
    fs::create_dir(root.join("stage")).map_err(|_| "staging exists")?;
    write_group(&root.join("stage"), &REPLACEMENT)?;
    if !matches_group(&root.join("stage"), &REPLACEMENT) {
        return Err("staging checksum mismatch");
    }
    append(root, Phase::Staged)?;
    if matches!(fault, Fault::AfterStage) { return Ok(()); }
    fs::rename(root.join("live"), root.join("rollback")).map_err(|_| "old directory rename failed")?;
    if matches!(fault, Fault::AfterOldRename) { return Ok(()); }
    append(root, Phase::OldMoved)?;
    if matches!(fault, Fault::AfterOldCheckpoint) { return Ok(()); }
    fs::rename(root.join("stage"), root.join("live")).map_err(|_| "new directory rename failed")?;
    if matches!(fault, Fault::AfterPromotionRename) { return Ok(()); }
    append(root, Phase::Promoted)?;
    Ok(())
}
fn recover(root: &Path, crash_after_quarantine: bool) -> Result<bool, &'static str> {
    let (_, phase) = read_journal(root)?;
    if phase == Some(Phase::RolledBack) {
        return Ok(matches_group(&root.join("live"), &ORIGINAL));
    }
    if !matches!(phase, Some(Phase::Staged | Phase::OldMoved | Phase::Promoted | Phase::RollbackPending)) {
        return Err("cannot recover from unknown phase");
    }
    // Check every available directory BEFORE moving anything, including a
    // previous interruption in the middle of rollback. Never overwrite unknown data.
    let old_saved = matches_group(&root.join("rollback"), &ORIGINAL);
    let old_live = matches_group(&root.join("live"), &ORIGINAL);
    let new_live = matches_group(&root.join("live"), &REPLACEMENT);
    let new_quarantined = matches_group(&root.join("quarantine"), &REPLACEMENT);
    let live_exists = fs::symlink_metadata(root.join("live")).is_ok();
    let rollback_exists = fs::symlink_metadata(root.join("rollback")).is_ok();
    let quarantine_exists = fs::symlink_metadata(root.join("quarantine")).is_ok();
    if (rollback_exists && !old_saved)
        || (live_exists && !old_live && !new_live)
        || (quarantine_exists && !new_quarantined)
        || (!old_live && !old_saved)
        || (old_live && old_saved)
        || (new_live && new_quarantined)
    { return Err("manual recovery required: unexpected file state"); }
    if phase != Some(Phase::RollbackPending) {
        append(root, Phase::RollbackPending)?;
    }
    if new_live {
        if quarantine_exists { return Err("quarantine already exists"); }
        fs::rename(root.join("live"), root.join("quarantine"))
            .map_err(|_| "cannot quarantine new fixture")?;
        if crash_after_quarantine { return Ok(false); }
    }
    if old_saved {
        fs::rename(root.join("rollback"), root.join("live"))
            .map_err(|_| "cannot restore original fixture")?;
    }
    if !matches_group(&root.join("live"), &ORIGINAL) {
        return Err("original checksum mismatch after recovery");
    }
    append(root, Phase::RolledBack)?;
    Ok(true)
}

#[test]
fn each_windows_directory_rename_interruption_restores_identical_original() {
    let Some(_) = Isolated::new() else { return };
    let cuts = [
        Fault::AfterStage, Fault::AfterOldRename, Fault::AfterOldCheckpoint,
        Fault::AfterPromotionRename, Fault::AfterPromotionCheckpoint, Fault::NoFault,
    ];
    for cut in cuts {
        let fixture = Isolated::new().unwrap();
        stage_and_switch(&fixture.root, cut).unwrap();
        assert!(recover(&fixture.root, false).unwrap());
        assert!(matches_group(&fixture.root.join("live"), &ORIGINAL));
        // Crash recovery is idempotent and never touches data again.
        assert!(recover(&fixture.root, false).unwrap());
        assert_eq!(read_journal(&fixture.root).unwrap().1, Some(Phase::RolledBack));
    }
}

#[test]
fn crash_during_rollback_is_recoverable_without_overwriting_unexpected_files() {
    let Some(fixture) = Isolated::new() else { return };
    stage_and_switch(&fixture.root, Fault::NoFault).unwrap();
    assert!(!recover(&fixture.root, true).unwrap());
    assert!(matches_group(&fixture.root.join("quarantine"), &REPLACEMENT));
    assert!(matches_group(&fixture.root.join("rollback"), &ORIGINAL));
    assert!(recover(&fixture.root, false).unwrap());
    assert!(matches_group(&fixture.root.join("live"), &ORIGINAL));
}

#[test]
fn damaged_journal_or_modified_backup_requires_manual_recovery() {
    let Some(fixture) = Isolated::new() else { return };
    stage_and_switch(&fixture.root, Fault::AfterOldCheckpoint).unwrap();
    fs::write(fixture.root.join("journal").join("0001.json"), b"{").unwrap();
    assert!(recover(&fixture.root, false).is_err());
    assert!(!fixture.root.join("live").exists());
    assert!(matches_group(&fixture.root.join("rollback"), &ORIGINAL));
    let fixture2 = Isolated::new().unwrap();
    stage_and_switch(&fixture2.root, Fault::AfterOldCheckpoint).unwrap();
    fs::write(fixture2.root.join("rollback").join("oauth.json"), b"changed").unwrap();
    assert!(recover(&fixture2.root, false).is_err());
    assert!(!fixture2.root.join("live").exists());
}
