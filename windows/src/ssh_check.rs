use crate::files::{Kind, Source};
use std::{fs, path::PathBuf};

pub fn host(variable: &str) -> String {
    let host = std::env::var(variable).expect("start the Windows SSH fixture");
    crate::ssh_destination::normalize(&host).expect("valid SSH fixture destination")
}

#[test]
#[ignore = "requires the loopback SSH fixture"]
fn windows_ssh_lists_previews_and_transfers_files() {
    let source = Source::Sftp {
        socket: Some(host("SPAN_TEST_SSH_HOST")),
    };
    let directory = source.list(None).expect("list files over Windows OpenSSH");
    assert_eq!(directory.path, PathBuf::from("/workspace"));
    let mut entries = directory.entries.iter();
    let notes = entries.next().expect("notes directory");
    assert!(notes.kind == Kind::Directory);
    assert_eq!(notes.name, "notes");
    let file = entries.next().expect("Markdown file");
    assert!(file.kind == Kind::File);
    assert_eq!(file.name, "样例.md");
    assert!(entries.next().is_none());
    let file = directory.path.join(&file.name);
    assert_eq!(
        source.preview(&file, 4096).expect("read the preview"),
        b"# Span loopback\n"
    );

    let folder = PathBuf::from(std::env::var_os("SPAN_TEST_SSH_DIR").expect("fixture directory"));
    let local = folder.join("上传 fixture.bin");
    let downloaded = folder.join("下载 fixture.bin");
    let remote = directory.path.join("传输 fixture.bin");
    let bytes: Vec<u8> = (0..200_000).map(|offset| (offset % 251) as u8).collect();
    fs::write(&local, &bytes).unwrap();
    source.upload(&local, &remote).expect("upload over SFTP");
    fs::write(&local, b"refuse replacement").unwrap();
    assert!(source.upload(&local, &remote).is_err());
    fs::write(&downloaded, b"replace after successful download").unwrap();
    source
        .download(&remote, &downloaded)
        .expect("download over SFTP");
    assert_eq!(fs::read(downloaded).unwrap(), bytes);
}
