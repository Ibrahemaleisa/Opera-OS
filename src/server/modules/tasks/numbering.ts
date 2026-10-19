import type { Tx } from "@/server/db/tenant";

/** Atomically allocates the next per-project task number (row lock via UPDATE). */
export async function nextTaskNumber(tx: Tx, projectId: string): Promise<number> {
  const p = await tx.project.update({ where: { id: projectId }, data: { taskSeq: { increment: 1 } }, select: { taskSeq: true } });
  return p.taskSeq;
}

export async function reserveTaskNumbers(tx: Tx, projectId: string, count: number): Promise<number> {
  const p = await tx.project.update({ where: { id: projectId }, data: { taskSeq: { increment: count } }, select: { taskSeq: true } });
  return p.taskSeq - count + 1;
}
