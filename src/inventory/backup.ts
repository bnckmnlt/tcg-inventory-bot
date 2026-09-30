import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readV2InventoryWorkbook } from "./read-xlsx.js";

const DEFAULT_RETENTION = 30;

export interface InventoryBackupOptions {
  workbookPath?: string;
  inventoryPath?: string;
  backupDirectory?: string;
  retention?: number;
}

export interface InventoryBackupResult {
  backupDirectory: string;
  workbookBackup?: string;
  inventoryBackup?: string;
  removedBackups: number;
}

export interface InventoryRollbackResult {
  backupDirectory: string;
  restoredWorkbook?: string;
  restoredInventory?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupDirectory(options?: InventoryBackupOptions): string {
  return path.resolve(
    options?.backupDirectory ??
      process.env.INVENTORY_BACKUP_DIRECTORY ??
      "data/backups",
  );
}

async function copyIfPresent(
  sourcePath: string | undefined,
  directory: string,
  stamp: string,
): Promise<string | undefined> {
  if (!sourcePath) return undefined;
  try {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  const destination = path.join(
    directory,
    path.basename(sourcePath) + "." + stamp + ".bak",
  );
  await copyFile(sourcePath, destination);
  return destination;
}

async function pruneBackups(directory: string, retention: number): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bak"))
    .sort((a, b) => b.name.localeCompare(a.name));

  const stale = backups.slice(retention);
  await Promise.all(
    stale.map((entry) =>
      rm(path.join(directory, entry.name), { force: true }),
    ),
  );
  return stale.length;
}

export async function createInventoryBackup(
  options: InventoryBackupOptions = {},
): Promise<InventoryBackupResult> {
  const directory = backupDirectory(options);
  const retention = Number(
    options.retention ??
      process.env.INVENTORY_BACKUP_RETENTION ??
      DEFAULT_RETENTION,
  );

  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error("INVENTORY_BACKUP_RETENTION must be a positive integer.");
  }

  await mkdir(directory, { recursive: true });

  const stamp = timestamp();
  const [workbookBackup, inventoryBackup] = await Promise.all([
    copyIfPresent(options.workbookPath, directory, stamp),
    copyIfPresent(options.inventoryPath, directory, stamp),
  ]);

  const removedBackups = await pruneBackups(directory, retention);

  if (!workbookBackup && !inventoryBackup) {
    throw new Error("No inventory state files were available to back up.");
  }

  return { backupDirectory: directory, workbookBackup, inventoryBackup, removedBackups };
}

async function validateWorkbookBackup(backupPath: string): Promise<void> {
  const parsed = readV2InventoryWorkbook(backupPath);
  if (parsed.issues.length > 0) {
    throw new Error(
      "Backup workbook failed validation: " +
        parsed.issues.map((issue) => issue.message).join(" | "),
    );
  }
}

export async function listInventoryBackups(
  options: InventoryBackupOptions = {},
): Promise<string[]> {
  const directory = backupDirectory(options);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".bak"))
      .map((entry) => path.join(directory, entry.name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

export async function restoreInventoryBackup(
  backupPath: string,
  options: InventoryBackupOptions = {},
): Promise<InventoryRollbackResult> {
  const directory = backupDirectory(options);
  const resolvedBackup = path.resolve(backupPath);

  if (!resolvedBackup.startsWith(directory + path.sep)) {
    throw new Error(
      "Rollback is restricted to backups inside the configured backup directory.",
    );
  }

  const backupName = path.basename(resolvedBackup);
  if (!backupName.endsWith(".bak")) {
    throw new Error("Rollback source must be a .bak backup file.");
  }

  let targetPath: string | undefined;

  if (
    options.workbookPath &&
    backupName.startsWith(path.basename(options.workbookPath) + ".")
  ) {
    targetPath = path.resolve(options.workbookPath);
    await validateWorkbookBackup(resolvedBackup);
  } else if (
    options.inventoryPath &&
    backupName.startsWith(path.basename(options.inventoryPath) + ".")
  ) {
    targetPath = path.resolve(options.inventoryPath);
  }

  if (!targetPath) {
    throw new Error(
      "Could not determine whether the backup is a configured workbook or inventory backup.",
    );
  }

  if (targetPath) {
    const rollbackSafetyCopy = path.join(
      directory,
      path.basename(targetPath) + ".before-rollback-" + timestamp() + ".bak",
    );
    await copyFile(targetPath, rollbackSafetyCopy);
  }

  await copyFile(resolvedBackup, targetPath);

  return {
    backupDirectory: directory,
    ...(targetPath.endsWith(".xlsx")
      ? { restoredWorkbook: targetPath }
      : { restoredInventory: targetPath }),
  };
}
