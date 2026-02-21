# Innovations Codex - Agent Notes

Date: 2026-01-27 (started), updated 2026-02-21
Environment: Foundry VTT v13, dnd5e system v5.2.5
Module path: \\desktop-rll1nd1\nodejsfoundrydata\data2024\Data\modules\innovations-codex
GitHub: https://github.com/override367/InnovationsCodex

## Module Overview

A Foundry VTT module for dnd5e that implements an "Innovations Codex" — a homebrew crafting system where players create blueprint items, assign them spell levels, and "fabricate" copies onto actors by spending spell slots.

### Architecture
```
Player uses "Create Innovation" feat on their character sheet
  -> Actor gets codex container if missing (copy from world item)
  -> InnovationsCodexApp window opens
     -> Blueprints tab: shows items in codex container
        -> "+" button: creates new innovation (dialog -> actor item + world mirror + GM notify)
        -> Slot dropdown: change level (update flags + move world mirror + GM notify)
        -> Fabricate button: disabled if uncategorized; otherwise spend slot and clone to target
     -> Active Innovations tab: shows fabricated items across all actors with Recall button
```

### Folder structure in Items directory
```
Innovations Codex/          <- root folder (type: Item)
  Create Innovation         <- feat item (isCreateFeature flag)
  Innovations Codex         <- container item (isCodex flag)
  Uncategorized/            <- subfolder for un-leveled innovations
  1st/ ... 9th/             <- subfolders for each spell level
```

### Files
| File | Purpose |
|------|---------|
| module.json | Manifest with socket:true, socketlib dependency, GitHub URLs |
| main.js | All module logic (~1000 lines) |
| templates/innovations-codex.hbs | Handlebars template for the codex window |
| styles/innovations-codex.css | Dark-theme-compatible CSS |

### Key Technical Decisions
- **socketlib** is used for ALL GM-privileged operations (creating items on actors, setting flags, deleting items, mirroring, notifications). This allows players to use the module even on actors they don't own.
- **dnd5e.preUseActivity** hook (not the deprecated `dnd5e.preUseItem`) intercepts the Create Innovation feat usage. Also suppresses `dialogConfig.configure` and `messageConfig.create` for compatibility with midi-qol.
- **Folder.create()** uses the `folder:` field (not `parent:`) for parent folder nesting in Foundry v13.
- **`f.folder?.id ?? f.folder`** pattern used everywhere for folder parent comparisons — `folder.folder` returns a Folder document object in v13, not a string ID.
- **Folder deduplication** runs on every GM load, deleting empty duplicate subfolders.
- **Utility activity** on the feat with `activation.type: "action"` is required for the "Use" button to appear on the dnd5e v5.x character sheet.

---

## Changelog

### Initial development (2026-01-27)
- Created basic module with ApplicationV2 window, blueprint/fabricate/recall system.
- Debugged blank window issue caused by custom _replaceHTML override.

### Major Rework (2026-02-21)
- Complete rewrite of all three code files.
- Added "Create Innovation" feat as the single entry point (replaces direct codex access).
- Added folder hierarchy (Innovations Codex + Uncategorized + 1st-9th subfolders).
- Added "+" button for creating new innovations with dialog.
- Slot levels default to null (Uncategorized); Fabricate disabled until level assigned.
- One-way mirror system: actor codex items sync to world Items folder.
- GM chat notifications on item creation and level changes.

### Bugfixes — round 2 (2026-02-21)
- Environment is dnd5e v5.2.5 / Foundry v13 (not v4.x / v12).
- Fixed folder nesting: `folder:` not `parent:` in Folder.create().
- Fixed item detection: ensureWorldItems() matches by flag only, not name+type.
- Fixed icons: feat = smithing-anvil-silver-red, codex = book-symbol-yellow-grey.
- Added utility activity to feat for Use button.
- Replaced dnd5e.preUseItem with dnd5e.preUseActivity.

### Bugfixes — round 3 (2026-02-21)
- Fixed folder parent comparisons: `f.folder` is a Folder object, not a string ID. All comparisons now use `f.folder?.id ?? f.folder` pattern.
- Added folder deduplication: detects and deletes empty duplicate subfolders on each GM load.
- Added stray folder cleanup: removes spell-level folders orphaned at Items root.
- Fixed mirror folder comparison using same pattern.

### CSS improvements (2026-02-21)
- Default icon size halved from 128px to 64px.
- All UI elements styled for dark Foundry theme using semi-transparent white backgrounds and light text (`#e0e0e0`).
- Buttons, selects, tab buttons, notices all have explicit readable colors.

### Socketlib migration (2026-02-21)
- Added `"socket": true` to module.json.
- Added socketlib as a required dependency.
- Replaced all raw `game.socket.emit/on` calls with socketlib.
- 7 GM handler functions registered via `socketlib.registerModule()`:
  | Handler | Purpose |
  |---------|---------|
  | addCodexToActor | Copy world codex to an actor |
  | createInnovation | Create innovation item inside actor's codex |
  | fabricate | Deduct spell slot + create temp item on target |
  | recall | Delete a fabricated item from an actor |
  | setFlag | Update flags on actor-owned items |
  | mirror | Create/move world item in spell-level folder |
  | notify | Send GM whisper chat message |
- All wrapper functions call `icSocket.executeAsGM()` — auto short-circuits if caller is GM.
- Triple-guarded registration: `socketlib.ready` hook, `init` hook fallback, `_ensureSocket()` at call time.
- Settings registration wrapped in try/catch to prevent socketlib errors from blocking `init`.
- Activity hook suppresses `dialogConfig.configure` and `messageConfig.create` for midi-qol compat.

### module.json GitHub setup (2026-02-21)
- Added `url`, `manifest`, `download` fields for GitHub-based installation.
- Repository: https://github.com/override367/InnovationsCodex

## Current status
- Module is functional. Requires world restart after first install (for socket channel allocation).
- Testing checklist:
  1. GM loads world -> folder hierarchy + world items created
  2. Add "Create Innovation" feat to a PC
  3. Use the feat -> codex added to actor, window opens
  4. Click "+" -> new innovation in codex + Uncategorized folder + GM notification
  5. Change spell level -> mirror moves to correct folder + GM notification
  6. Fabricate (with level) -> spell slot consumed, temp item on target
  7. Recall -> fabricated item deleted

## Important notes for future agents
- **Always use `f.folder?.id ?? f.folder`** when comparing folder parents — never raw `f.folder === someId`.
- **socketlib requires world restart** after adding `"socket": true` to manifest.
- **dnd5e v5.x uses activities**, not direct item use. Hook is `dnd5e.preUseActivity`, parameter is `activity` (access item via `activity.item`).
- **midi-qol wraps activity.use()** — `return false` from hook may not fully cancel; also set `dialogConfig.configure = false` and `messageConfig.create = false`.
