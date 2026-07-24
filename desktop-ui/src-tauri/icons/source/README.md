# MemoryBread icon masters

- `memorybread-app-icon.svg`: canonical light application-icon artwork.
- `memorybread-mark.svg`: canonical transparent brand mark.

Generate the cross-platform Tauri icon set from `memorybread-app-icon.svg`:

```bash
npm exec tauri icon -- --output ./src-tauri/icons --ios-color '#FFF4DF' ./src-tauri/icons/source/memorybread-app-icon.svg
```

After generation, flatten every PNG in `src-tauri/icons/ios` onto `#FFF4DF` and save it without an alpha channel for App Store compatibility. Do not replace `../tray-template.rgba`; it is the protected macOS menu-bar icon.
