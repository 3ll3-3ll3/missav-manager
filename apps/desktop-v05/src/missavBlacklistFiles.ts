import {
  getAppSetting,
  readMissavBlacklistFiles,
  setAppSetting,
  writeMissavBlacklistFile,
  type MissavBlacklistFileKind,
  type MissavBlacklistFilesSnapshot,
} from "./api";
import {
  MISSAV_RAINDROP_EXPORT_TAG_BLACKLIST_SETTING,
  MISSAV_REFERENCE_TAG_BLACKLIST_SETTING,
  normalizeReferenceTagBlacklist,
  referenceTagBlacklistFromText,
  referenceTagBlacklistToText,
} from "./missavReferenceTags";

const BLACKLIST_FILES_INITIALIZED_SETTING = "missav.blacklistFilesInitializedV1";

export interface MissavBlacklistFileValues {
  snapshot: MissavBlacklistFilesSnapshot;
  reference: string[];
  raindropExport: string[];
}

function valuesFromSnapshot(snapshot: MissavBlacklistFilesSnapshot): MissavBlacklistFileValues {
  return {
    snapshot,
    reference: referenceTagBlacklistFromText(snapshot.referenceText),
    raindropExport: referenceTagBlacklistFromText(snapshot.raindropExportText),
  };
}

function normalizedLegacy(value: unknown): string[] {
  return normalizeReferenceTagBlacklist(Array.isArray(value) ? value : []);
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function textForFile(values: string[]): string {
  const body = referenceTagBlacklistToText(values);
  return body ? `${body}\n` : "";
}

async function mirrorDatabaseSettings(values: MissavBlacklistFileValues): Promise<void> {
  const [legacyReference, legacyExport] = await Promise.all([
    getAppSetting<unknown>(MISSAV_REFERENCE_TAG_BLACKLIST_SETTING),
    getAppSetting<unknown>(MISSAV_RAINDROP_EXPORT_TAG_BLACKLIST_SETTING),
  ]);
  const updates: Promise<void>[] = [];
  if (!sameValues(normalizedLegacy(legacyReference), values.reference)) {
    updates.push(setAppSetting(MISSAV_REFERENCE_TAG_BLACKLIST_SETTING, values.reference));
  }
  if (!sameValues(normalizedLegacy(legacyExport), values.raindropExport)) {
    updates.push(setAppSetting(MISSAV_RAINDROP_EXPORT_TAG_BLACKLIST_SETTING, values.raindropExport));
  }
  await Promise.all(updates);
}

export async function loadMissavBlacklistFileValues(): Promise<MissavBlacklistFileValues> {
  let snapshot = await readMissavBlacklistFiles();
  const initialized = await getAppSetting<boolean>(BLACKLIST_FILES_INITIALIZED_SETTING);
  if (!initialized) {
    const [legacyReference, legacyExport] = await Promise.all([
      getAppSetting<unknown>(MISSAV_REFERENCE_TAG_BLACKLIST_SETTING),
      getAppSetting<unknown>(MISSAV_RAINDROP_EXPORT_TAG_BLACKLIST_SETTING),
    ]);
    const reference = referenceTagBlacklistFromText(snapshot.referenceText);
    const raindropExport = referenceTagBlacklistFromText(snapshot.raindropExportText);
    const legacyReferenceValues = normalizedLegacy(legacyReference);
    const legacyExportValues = normalizedLegacy(legacyExport);
    if (!reference.length && legacyReferenceValues.length) {
      snapshot = await writeMissavBlacklistFile("reference", textForFile(legacyReferenceValues));
    }
    if (!raindropExport.length && legacyExportValues.length) {
      snapshot = await writeMissavBlacklistFile("raindrop_export", textForFile(legacyExportValues));
    }
    await setAppSetting(BLACKLIST_FILES_INITIALIZED_SETTING, true);
  }

  const values = valuesFromSnapshot(snapshot);
  await mirrorDatabaseSettings(values);
  return values;
}

export async function saveMissavBlacklistFileText(kind: MissavBlacklistFileKind, text: string): Promise<MissavBlacklistFileValues> {
  const values = referenceTagBlacklistFromText(text);
  const snapshot = await writeMissavBlacklistFile(kind, textForFile(values));
  await setAppSetting(BLACKLIST_FILES_INITIALIZED_SETTING, true);
  const loaded = valuesFromSnapshot(snapshot);
  await mirrorDatabaseSettings(loaded);
  return loaded;
}
