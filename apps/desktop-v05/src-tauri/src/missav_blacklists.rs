use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const REFERENCE_FILE_NAME: &str = "1-参考女优Tag库黑名单.txt";
pub const RAINDROP_EXPORT_FILE_NAME: &str = "2-Raindrop导出黑名单.txt";
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Copy)]
pub enum BlacklistKind {
    Reference,
    RaindropExport,
}

impl BlacklistKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "reference" => Ok(Self::Reference),
            "raindrop_export" => Ok(Self::RaindropExport),
            _ => Err("未知黑名单类型，只允许 reference 或 raindrop_export".to_string()),
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::Reference => REFERENCE_FILE_NAME,
            Self::RaindropExport => RAINDROP_EXPORT_FILE_NAME,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistFilesSnapshot {
    pub directory: String,
    pub reference_path: String,
    pub raindrop_export_path: String,
    pub reference_text: String,
    pub raindrop_export_text: String,
}

pub fn resolve_default_directory() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("TG_TOOLBOX_BLACKLIST_DIR") {
        return Ok(PathBuf::from(path));
    }

    let executable = std::env::current_exe().map_err(|error| format!("无法定位程序路径：{error}"))?;
    for ancestor in executable.ancestors() {
        if ancestor.join("README.md").is_file()
            && ancestor.join("apps").join("desktop-v05").join("package.json").is_file()
        {
            return Ok(ancestor.join("missav-blacklists"));
        }
    }

    let executable_dir = executable
        .parent()
        .ok_or_else(|| "无法定位 EXE 所在目录".to_string())?;
    Ok(executable_dir.join("missav-blacklists"))
}

pub fn ensure_files(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("创建黑名单目录失败：{error}"))?;
    for name in [REFERENCE_FILE_NAME, RAINDROP_EXPORT_FILE_NAME] {
        let path = directory.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => file.flush().map_err(|error| format!("创建黑名单文件失败：{error}"))?,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("创建黑名单文件失败：{error}")),
        }
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取黑名单文件失败：{error}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("黑名单文件超过 5 MB：{}", path.display()));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取黑名单文件失败：{error}"))?;
    Ok(String::from_utf8(bytes)
        .map_err(|_| format!("黑名单文件必须是 UTF-8 文本：{}", path.display()))?
        .trim_start_matches('\u{feff}')
        .to_string())
}

pub fn read_files(directory: &Path) -> Result<BlacklistFilesSnapshot, String> {
    ensure_files(directory)?;
    let reference_path = directory.join(REFERENCE_FILE_NAME);
    let raindrop_export_path = directory.join(RAINDROP_EXPORT_FILE_NAME);
    Ok(BlacklistFilesSnapshot {
        directory: directory.display().to_string(),
        reference_path: reference_path.display().to_string(),
        raindrop_export_path: raindrop_export_path.display().to_string(),
        reference_text: read_file(&reference_path)?,
        raindrop_export_text: read_file(&raindrop_export_path)?,
    })
}

pub fn write_file(directory: &Path, kind: BlacklistKind, content: &str) -> Result<BlacklistFilesSnapshot, String> {
    ensure_files(directory)?;
    if content.as_bytes().len() as u64 > MAX_FILE_BYTES {
        return Err("黑名单内容超过 5 MB，已拒绝保存".to_string());
    }
    let target = directory.join(kind.file_name());
    let temporary = directory.join(format!(".{}.tmp", kind.file_name()));
    {
        let mut file = fs::File::create(&temporary).map_err(|error| format!("创建黑名单临时文件失败：{error}"))?;
        file.write_all(content.as_bytes()).map_err(|error| format!("写入黑名单失败：{error}"))?;
        file.sync_all().map_err(|error| format!("刷新黑名单文件失败：{error}"))?;
    }
    if fs::rename(&temporary, &target).is_err() {
        fs::write(&target, content.as_bytes()).map_err(|error| format!("替换黑名单文件失败：{error}"))?;
        let _ = fs::remove_file(&temporary);
    }
    read_files(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_reads_and_updates_two_independent_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let initial = read_files(temp.path()).expect("initial files");
        assert!(Path::new(&initial.reference_path).is_file());
        assert!(Path::new(&initial.raindrop_export_path).is_file());
        assert!(initial.reference_text.is_empty());
        assert!(initial.raindrop_export_text.is_empty());

        let after_reference = write_file(temp.path(), BlacklistKind::Reference, "女优甲\n").expect("reference write");
        assert_eq!(after_reference.reference_text, "女优甲\n");
        assert!(after_reference.raindrop_export_text.is_empty());

        let after_export = write_file(temp.path(), BlacklistKind::RaindropExport, "女优乙\n").expect("export write");
        assert_eq!(after_export.reference_text, "女优甲\n");
        assert_eq!(after_export.raindrop_export_text, "女优乙\n");
    }

    #[test]
    fn rejects_unknown_kind_and_oversized_content() {
        assert!(BlacklistKind::parse("both").is_err());
        let temp = tempfile::tempdir().expect("tempdir");
        let oversized = "x".repeat(MAX_FILE_BYTES as usize + 1);
        assert!(write_file(temp.path(), BlacklistKind::Reference, &oversized).is_err());
    }
}
