fn main() {
    println!("cargo:rerun-if-changed=span.ico");
    #[cfg(windows)]
    winresource::WindowsResource::new()
        .set_icon("span.ico")
        .set("FileDescription", "Span")
        .set("ProductName", "Span")
        .compile()
        .expect("embed Span's Windows icon");
}
