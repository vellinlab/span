#!/usr/bin/env bash
set -euo pipefail

package=dist/windows/Span
runtime=/mingw64
mkdir -p "$package/share/licenses"
install -Dm755 target/x86_64-pc-windows-gnu/release/span.exe "$package/Span.exe"
install -Dm644 README.md "$package/README.md"

loaders=lib/gdk-pixbuf-2.0/2.10.0
mkdir -p "$package/$loaders/loaders"
for module in "$runtime/$loaders/loaders/"{*png,*jpeg,*svg}.dll; do
    if [[ -f "$module" ]]; then
        install -m755 "$module" "$package/$loaders/loaders/"
    fi
done
loader_dlls=("$package/$loaders/loaders/"*.dll)
if [[ -e "${loader_dlls[0]}" ]]; then
    "$runtime/bin/gdk-pixbuf-query-loaders.exe" "${loader_dlls[@]}" |
        sed -E 's#^"[^"]*[/\\]+loaders[/\\]+([^"\\]+\.dll)"#"lib/gdk-pixbuf-2.0/2.10.0/loaders/\1"#' \
        > "$package/$loaders/loaders.cache"
fi

# Package only the imported runtime DLLs and usable GTK data.
declare -A copied=()
collect_dlls() {
    local dll
    while IFS= read -r dll; do
        if [[ -f "$runtime/bin/$dll" && ! -v "copied[$dll]" ]]; then
            copied["$dll"]=1
            install -m755 "$runtime/bin/$dll" "$package/$dll"
            collect_dlls "$runtime/bin/$dll"
        fi
    done < <(objdump -p "$1" | awk '/DLL Name:/ { print $3 }')
}
collect_dlls "$package/Span.exe"
for helper in gspawn-win64-helper.exe gspawn-win64-helper-console.exe; do
    install -m755 "$runtime/bin/$helper" "$package/$helper"
    collect_dlls "$runtime/bin/$helper"
done
for module in "${loader_dlls[@]}"; do
    if [[ -f "$module" ]]; then
        collect_dlls "$module"
    fi
done

for item in glib-2.0/schemas icons/Adwaita icons/hicolor; do
    if [[ -d "$runtime/share/$item" ]]; then
        mkdir -p "$package/share/$(dirname "$item")"
        cp -R "$runtime/share/$item" "$package/share/$item"
    fi
done

for dll in "${!copied[@]}"; do
    pacman -Qo "$runtime/bin/$dll"
done | sort -u > "$package/share/licenses/runtime-packages.txt"
while read -r owner; do
    pacman -Qi "$owner"
done < <(awk '{ print $(NF-1) }' "$package/share/licenses/runtime-packages.txt" | sort -u) \
    > "$package/share/licenses/package-details.txt"
cp -R "$runtime/share/licenses/." "$package/share/licenses/"
