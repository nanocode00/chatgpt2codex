import { DomainError, ErrorCode, type ToolContext } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import type { SafeAdapterOperationRegistry } from "./operation-registry.js";

export async function invokeSafeAdapterOperation(
  ctx: ToolContext,
  registry: SafeAdapterOperationRegistry,
  projectId: string,
  operationId: string,
  argumentsValue: Record<string, unknown>,
): Promise<{ operation: string; result: unknown }> {
  const operation = registry.get(operationId);
  const entry = ctx.registry.find((project) => project.projectId === projectId);
  if (!entry) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, "Project not found");

  let input: Record<string, unknown>;
  try {
    input = operation.validateInput(argumentsValue);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation arguments are invalid");
  }

  await requireProjectLease(ctx, projectId, operation.capability);
  try {
    const result = await operation.handler({ ctx, projectId, projectRoot: entry.root }, input);
    return { operation: operation.id, result };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Safe adapter operation failed");
  }
}
