import { getD1 } from "../db";

export async function commitPersonalSyncCheckpoint(
  statements: D1PreparedStatement[],
  assertRemoteLease: () => void = () => undefined,
) {
  assertRemoteLease();
  return getD1().batch(statements);
}
