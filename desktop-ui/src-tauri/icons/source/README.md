# MemoryBread icon masters

- `memorybread-app-icon.svg`: canonical light application-icon artwork.
- `memorybread-macos-app-icon.svg`: macOS variant with Dock-safe transparent padding.
- `memorybread-mark.svg`: canonical transparent brand mark.

Generate the cross-platform Tauri icon set from `memorybread-app-icon.svg`:

```bash
npm exec tauri icon -- --output ./src-tauri/icons --ios-color '#FFF4DF' ./src-tauri/icons/source/memorybread-app-icon.svg
```

Then generate the macOS icon in a temporary directory and replace only
`src-tauri/icons/icon.icns` so other platforms keep their native sizing:

```bash
tmp_dir="$(mktemp -d)"
npm exec tauri icon -- --output "$tmp_dir" ./src-tauri/icons/source/memorybread-macos-app-icon.svg
cp "$tmp_dir/icon.icns" ./src-tauri/icons/icon.icns
```

After generation, flatten every PNG in `src-tauri/icons/ios` onto `#FFF4DF` and save it without an alpha channel for App Store compatibility. Do not replace `../tray-template.rgba`; it is the protected macOS menu-bar icon.
