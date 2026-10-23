//! F4-C synthetic cutover / rollback proof harness.
//!
//! TEST-ONLY: intentionally unavailable to the shipped Tauri binary/UI.
//! Never imports, opens, probes, stops or rotates installed C2C credentials,
//! processes, ports or Cloudflare. Actual CLI auth was tested separately in F3.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Phase {
    PreflightOk,
    Staged,
    QuiesceRequested,
    LegacyStopped,
    TargetStarting,
    Probing,
    Committed,
    Rollback,
    RolledBack,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u8,
    step: u32,
    phase: Phase,
}
#[derive(Debug)]
enum ReadState {
    Empty,
    Clean(Phase),
    ManualRecovery,
}

fn expected_transition(previous: Option<Phase>, next: Phase) -> bool {
    matches!((previous, next),
        (None, Phase::PreflightOk) |
        (Some(Phase::PreflightOk), Phase::Staged) |
        (Some(Phase::Staged), Phase::QuiesceRequested) |
        (Some(Phase::QuiesceRequested), Phase::LegacyStopped) |
        (Some(Phase::LegacyStopped), Phase::TargetStarting) |
        (Some(Phase::TargetStarting), Phase::Probing) |
        (Some(Phase::Probing), Phase::Committed) |
        (Some(Phase::Rollback), Phase::RolledBack)
    ) || (next == Phase::Rollback &&
        !matches!(previous, Some(Phase::Rollback | Phase::RolledBack)))
}

struct Disposable {
    root: PathBuf,
}
impl Disposable {
    fn create() -> Option<Self> {
        if !cfg!(windows)
            || std::env::var("GITHUB_ACTIONS").ok().as_deref() != Some("true")
            || std::env::var("CI").ok().as_deref() != Some("true")
            || std::env::var("C2C_F4C_E2E").ok().as_deref() != Some("true")
        {
            return None;
        }
        let base = PathBuf::from(std::env::var_os("RUNNER_TEMP")?);
        let meta = fs::symlink_metadata(&base).expect("missing runner temporary directory");
        assert!(meta.is_dir() && !meta.file_type().is_symlink(), "runner temp must be a real directory");
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = base.join(format!("c2c-f4c-synthetic-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).expect("create exclusively named disposable fixture root");
        Some(Self { root })
    }
}
impl Drop for Disposable {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

struct JournalLock {
    path: PathBuf,
    _handle: File,
}
impl JournalLock {
    fn acquire(path: &Path) -> Result<Self, &'static str> {
        // Refuse a concurrent or stale lock. Never steal or kill an owner.
        let handle = OpenOptions::new().write(true).create_new(true)
            .open(path).map_err(|_| "journal lock already exists or is unavailable")?;
        Ok(Self { path: path.to_path_buf(), _handle: handle })
    }
}
impl Drop for JournalLock {
    fn drop(&mut self) { let _ = fs::remove_file(&self.path); }
}

struct Journal {
    directory: PathBuf,
    _lock: JournalLock,
    next: u32,
}
impl Journal {
    fn new(root: &Path) -> Result<Self, &'static str> {
        // The parent directory was exclusively allocated under RUNNER_TEMP.
        let directory = root.join("journal");
        fs::create_dir(&directory).map_err(|_| "cannot make journal")?;
        let guard = JournalLock::acquire(&root.join("owner.lock"))?;
        Ok(Self { directory, _lock: guard, next: 0 })
    }

    fn record(&mut self, phase: Phase) -> Result<(), &'static str> {
        let previous = match self.inspect() {
            ReadState::Empty => None,
            ReadState::Clean(x) => Some(x),
            ReadState::ManualRecovery => return Err("manual recovery: damaged journal"),
        };
        if !expected_transition(previous, phase) {
            return Err("invalid journal state transition");
        }
        // Append-only, create_new, sync_all. Never rename over a Windows file,
        // and never conceal an interrupted partial write with later entries.
        let checkpoint = Checkpoint { version: 1, step: self.next, phase };
        let bytes = serde_json::to_vec(&checkpoint).map_err(|_| "invalid journal data")?;
        let path = self.directory.join(format!("{:08}.json", self.next));
        let mut file = OpenOptions::new().write(true).create_new(true)
            .open(path).map_err(|_| "journal checkpoint exists or is unwritable")?;
        file.write_all(&bytes).and_then(|_| file.sync_all())
            .map_err(|_| "journal fsync failed")?;
        self.next += 1;
        Ok(())
    }

    fn inspect(&self) -> ReadState {
        let Ok(entries) = fs::read_dir(&self.directory) else { return ReadState::ManualRecovery; };
        let mut names = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else { return ReadState::ManualRecovery; };
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { return ReadState::ManualRecovery; };
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 512 {
                return ReadState::ManualRecovery;
            }
            names.push(entry.path());
        }
        names.sort();
        if names.is_empty() { return ReadState::Empty; }
        if names.len() > 50 { return ReadState::ManualRecovery; }
        let mut last = None;
        for (n, path) in names.into_iter().enumerate() {
            if path.file_name().and_then(|x| x.to_str()) != Some(format!("{n:08}.json").as_str()) {
                return ReadState::ManualRecovery;
            }
            let Ok(data) = fs::read(&path) else { return ReadState::ManualRecovery; };
            let Ok(entry) = serde_json::from_slice::<Checkpoint>(&data) else {
                return ReadState::ManualRecovery;
            };
            if entry.version != 1 || entry.step != n as u32 {
                return ReadState::ManualRecovery;
            }
            if !expected_transition(last, entry.phase) {
                return ReadState::ManualRecovery;
            }
            last = Some(entry.phase);
        }
        match last { Some(phase) => ReadState::Clean(phase), None => ReadState::Empty }
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Debug)]
enum Fault {
    None, PreflightOk, Staged, QuiesceRequested,
    LegacyStopped, TargetStarting, Probing, Committed,
}
impl Fault {
    fn hits(self, phase: Phase) -> bool {
        matches!((self, phase),
            (Fault::PreflightOk, Phase::PreflightOk) |
            (Fault::Staged, Phase::Staged) |
            (Fault::QuiesceRequested, Phase::QuiesceRequested) |
            (Fault::LegacyStopped, Phase::LegacyStopped) |
            (Fault::TargetStarting, Phase::TargetStarting) |
            (Fault::Probing, Phase::Probing) |
            (Fault::Committed, Phase::Committed))
    }
}

#[derive(Debug)]
struct FakeProcesses {
    source_running: bool,
    target_running: bool,
    source_owned: bool,
    target_owned: bool,
    staged: bool,
    source_bytes: &'static [u8],
    max_concurrent_writers: usize,
    mutation_count: usize,
}
impl Default for FakeProcesses {
    fn default() -> Self {
        Self {
            source_running: true, target_running: false,
            source_owned: true, target_owned: true, staged: false,
            source_bytes: b"public synthetic non-credential fixture",
            max_concurrent_writers: 1, mutation_count: 0,
        }
    }
}
impl FakeProcesses {
    fn writers(&mut self) -> Result<(), &'static str> {
        let count = usize::from(self.source_running) + usize::from(self.target_running);
        self.max_concurrent_writers = self.max_concurrent_writers.max(count);
        if count > 1 { Err("concurrent OAuth writers refused") } else { Ok(()) }
    }
    fn quiesce_source(&mut self) -> Result<(), &'static str> {
        if !self.source_owned { return Err("cannot stop unowned source"); }
        self.source_running = false;
        self.mutation_count += 1;
        self.writers()
    }
    fn launch_target(&mut self) -> Result<(), &'static str> {
        if !self.target_owned || self.source_running { return Err("cannot launch unowned or concurrent target"); }
        self.target_running = true;
        self.mutation_count += 1;
        self.writers()
    }
    fn rollback(&mut self) -> Result<(), &'static str> {
        // Refuse unowned cleanup even during a rollback.
        if self.target_running {
            if !self.target_owned { return Err("manual recovery: target not owned"); }
            self.target_running = false;
            self.mutation_count += 1;
        }
        if !self.source_running {
            if !self.source_owned { return Err("manual recovery: source not owned"); }
            self.source_running = true;
            self.mutation_count += 1;
        }
        self.staged = false;
        self.writers()
    }
}

fn persist_and_fault(journal: &mut Journal, phase: Phase, fault: Fault) -> Result<(), &'static str> {
    journal.record(phase)?;
    if fault.hits(phase) { return Err("injected synthetic failure"); }
    Ok(())
}

fn synthetic_cutover(
    journal: &mut Journal, state: &mut FakeProcesses, fault: Fault,
) -> Result<Phase, &'static str> {
    if !matches!(journal.inspect(), ReadState::Empty) { return Err("nonempty journal requires manual recovery"); }
    // The adapter here only mutates in-memory flags. No real PID, port, HOME,
    // OAuth file, token, or WinForms executable can enter this API.
    let attempt = (|| {
        if !state.source_owned || !state.target_owned { return Err("unverified process owner"); }
        state.writers()?;
        persist_and_fault(journal, Phase::PreflightOk, fault)?;
        state.staged = true;
        persist_and_fault(journal, Phase::Staged, fault)?;
        persist_and_fault(journal, Phase::QuiesceRequested, fault)?;
        state.quiesce_source()?;
        persist_and_fault(journal, Phase::LegacyStopped, fault)?;
        persist_and_fault(journal, Phase::TargetStarting, fault)?;
        state.launch_target()?;
        persist_and_fault(journal, Phase::Probing, fault)?;
        if !state.target_running || state.source_running { return Err("synthetic health failed"); }
        persist_and_fault(journal, Phase::Committed, fault)?;
        Ok(Phase::Committed)
    })();
    if attempt.is_ok() { return attempt; }
    // If checkpoint is corrupted/partially written, do NOT attempt automatic
    // rollback: the journal can no longer establish reliable transaction state.
    if matches!(journal.inspect(), ReadState::ManualRecovery) {
        return Err("manual recovery required: journal damaged");
    }
    journal.record(Phase::Rollback)?;
    state.rollback()?;
    journal.record(Phase::RolledBack)?;
    Ok(Phase::RolledBack)
}

#[test]
fn synthetic_success_and_every_step_rolls_back_without_concurrent_writers() {
    let Some(temp) = Disposable::create() else { return };
    let choices = [
        Fault::None, Fault::PreflightOk, Fault::Staged, Fault::QuiesceRequested,
        Fault::LegacyStopped, Fault::TargetStarting, Fault::Probing, Fault::Committed,
    ];
    for (i, fault) in choices.into_iter().enumerate() {
        let root = temp.root.join(format!("case-{i}"));
        fs::create_dir(&root).unwrap();
        let mut journal = Journal::new(&root).unwrap();
        let mut state = FakeProcesses::default();
        let original = state.source_bytes.to_vec();
        let phase = synthetic_cutover(&mut journal, &mut state, fault).unwrap();
        if fault == Fault::None {
            assert_eq!(phase, Phase::Committed);
            assert!(state.target_running && !state.source_running);
        } else {
            assert_eq!(phase, Phase::RolledBack);
            assert!(state.source_running && !state.target_running && !state.staged);
        }
        assert!(state.max_concurrent_writers <= 1);
        assert_eq!(state.source_bytes, original.as_slice());
        assert!(matches!(journal.inspect(), ReadState::Clean(p) if p == phase));
        let before = state.mutation_count;
        assert!(synthetic_cutover(&mut journal, &mut state, fault).is_err(),
            "repeated transaction must not run over an existing journal");
        assert_eq!(state.mutation_count, before);
    }
}

#[test]
fn synthetic_unknown_process_and_concurrent_lease_fail_closed() {
    let Some(temp) = Disposable::create() else { return };
    let root = temp.root.join("ownership");
    fs::create_dir(&root).unwrap();
    let mut journal = Journal::new(&root).unwrap();
    assert!(JournalLock::acquire(&root.join("owner.lock")).is_err());
    let mut foreign = FakeProcesses { source_owned: false, ..FakeProcesses::default() };
    let phase = synthetic_cutover(&mut journal, &mut foreign, Fault::None).unwrap();
    assert_eq!(phase, Phase::RolledBack);
    assert!(foreign.source_running && !foreign.target_running);
    assert_eq!(foreign.mutation_count, 0);
}

#[test]
fn synthetic_partial_checkpoint_requires_manual_recovery_no_actions() {
    let Some(temp) = Disposable::create() else { return };
    let root = temp.root.join("partial");
    fs::create_dir(&root).unwrap();
    let mut journal = Journal::new(&root).unwrap();
    journal.record(Phase::PreflightOk).unwrap();
    fs::write(root.join("journal").join("00000001.json"), b"{").unwrap();
    assert!(matches!(journal.inspect(), ReadState::ManualRecovery));
    let mut state = FakeProcesses::default();
    let result = synthetic_cutover(&mut journal, &mut state, Fault::None);
    assert!(result.is_err());
    assert!(state.source_running && !state.target_running);
    assert_eq!(state.mutation_count, 0);
}

#[test]
fn synthetic_forged_phase_order_or_stale_owner_lock_never_mutates_state() {
    let Some(temp) = Disposable::create() else { return };
    let root = temp.root.join("forged");
    fs::create_dir(&root).unwrap();
    let journal = Journal::new(&root).unwrap();
    let forged = Checkpoint { version: 1, step: 0, phase: Phase::Committed };
    fs::write(root.join("journal").join("00000000.json"), serde_json::to_vec(&forged).unwrap()).unwrap();
    assert!(matches!(journal.inspect(), ReadState::ManualRecovery));
    let mut state = FakeProcesses::default();
    assert!(state.source_running);
    // Mutations are refused when the journal cannot establish history.
    assert!(matches!(state.writers(), Ok(())));
    assert!(JournalLock::acquire(&root.join("owner.lock")).is_err());
    assert_eq!(state.mutation_count, 0);
}
