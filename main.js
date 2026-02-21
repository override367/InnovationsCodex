const MODULE_ID = "innovations-codex";
const CODEX_NAME = "Innovations Codex";
const FEAT_NAME = "Create Innovation";
const RECENT_OPEN = new Map();

const SPELL_LEVEL_FOLDERS = [
  "Uncategorized",
  "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"
];

/** @type {import("socketlib").SocketlibSocket} */
let icSocket;

function _registerSocketlib() {
  if (icSocket) return; // Already registered
  const sock = socketlib.registerModule(MODULE_ID);
  if (!sock) {
    console.error(`${MODULE_ID} | socketlib.registerModule returned undefined. Make sure "socket":true is in module.json and you have restarted the world from the Foundry setup screen (not just refreshed the browser).`);
    return;
  }
  sock.register("addCodexToActor", _gmAddCodexToActor);
  sock.register("createInnovation", _gmCreateInnovation);
  sock.register("fabricate", _gmFabricate);
  sock.register("recall", _gmRecall);
  sock.register("setFlag", _gmSetFlag);
  sock.register("mirror", _gmMirror);
  sock.register("notify", _gmNotify);
  icSocket = sock;
  console.log(`${MODULE_ID} | socketlib registered successfully`);
}

/* ================================================== */
/*  SECTION 1: GM-only handler functions              */
/*  These run on the GM client via socketlib          */
/* ================================================== */

/**
 * GM handler: Add a codex container to an actor.
 * @param {string} actorUuid - The actor to receive the codex
 * @returns {string|null} The UUID of the created codex item, or null
 */
async function _gmAddCodexToActor(actorUuid) {
  const actor = await fromUuid(actorUuid);
  if (!(actor instanceof Actor)) return null;

  // Check if already has codex
  const existing = actor.items.find((i) => isCodexItem(i));
  if (existing) return existing.uuid;

  // Find world codex template
  const worldCodex = game.items.find((i) => i.getFlag?.(MODULE_ID, "isCodex"));
  if (!worldCodex) return null;

  const codexData = worldCodex.toObject();
  delete codexData._id;
  delete codexData.folder;
  foundry.utils.setProperty(codexData, "system.container", null);
  foundry.utils.setProperty(codexData, "system.containerId", null);

  const [created] = await actor.createEmbeddedDocuments("Item", [codexData]);
  return created?.uuid ?? null;
}

/**
 * GM handler: Create a new innovation item inside an actor's codex.
 * @param {string} actorUuid
 * @param {string} codexId - The ID of the codex item on the actor
 * @param {string} itemName
 * @param {string} itemType
 * @returns {string|null} UUID of the created item
 */
async function _gmCreateInnovation(actorUuid, codexId, itemName, itemType) {
  const actor = await fromUuid(actorUuid);
  if (!(actor instanceof Actor)) return null;

  const [created] = await actor.createEmbeddedDocuments("Item", [{
    name: itemName,
    type: itemType || "loot",
    flags: {
      [MODULE_ID]: {
        isInnovation: true,
        spellLevel: null,
        createdBy: actorUuid
      }
    },
    system: {
      container: codexId
    }
  }]);

  return created?.uuid ?? null;
}

/**
 * GM handler: Fabricate an item onto a target actor.
 * Deducts a spell slot from the owner and creates a temporary copy on the target.
 * @param {string} ownerActorUuid
 * @param {string} targetActorUuid
 * @param {string} blueprintUuid
 * @param {string} codexUuid
 * @param {number} slotLevel
 * @returns {boolean} success
 */
async function _gmFabricate(ownerActorUuid, targetActorUuid, blueprintUuid, codexUuid, slotLevel) {
  const ownerActor = await fromUuid(ownerActorUuid);
  const targetActor = await fromUuid(targetActorUuid);
  const blueprint = await fromUuid(blueprintUuid);

  if (!(ownerActor instanceof Actor) || !(targetActor instanceof Actor) || !(blueprint instanceof Item)) {
    return false;
  }

  // Deduct spell slot
  const slotPath = `system.spells.spell${slotLevel}.value`;
  const currentSlots = foundry.utils.getProperty(ownerActor, slotPath);
  if (!Number.isFinite(currentSlots) || currentSlots <= 0) return false;

  await ownerActor.update({ [slotPath]: currentSlots - 1 });

  // Create temporary item on target
  const itemData = blueprint.toObject();
  delete itemData._id;
  foundry.utils.setProperty(itemData, "system.container", null);
  foundry.utils.setProperty(itemData, "system.containerId", null);
  itemData.name = `Temporary ${blueprint.name}`;
  foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.originUuid`, codexUuid);
  foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.isTemporary`, true);

  await targetActor.createEmbeddedDocuments("Item", [itemData]);
  return true;
}

/**
 * GM handler: Recall (delete) a fabricated item.
 * @param {string} itemUuid
 * @param {string} codexUuid
 * @returns {boolean}
 */
async function _gmRecall(itemUuid, codexUuid) {
  const item = await fromUuid(itemUuid);
  if (!(item instanceof Item)) return false;
  const originUuid = item.getFlag(MODULE_ID, "originUuid");
  if (originUuid !== codexUuid) return false;

  if (item.parent instanceof Actor) {
    await item.parent.deleteEmbeddedDocuments("Item", [item.id]);
  } else {
    await item.delete();
  }
  return true;
}

/**
 * GM handler: Update flags on an actor-owned item (codex or blueprint).
 * @param {string} itemUuid
 * @param {string} flagKey - e.g. "slotLevelsByUuid"
 * @param {*} flagValue
 */
async function _gmSetFlag(itemUuid, flagKey, flagValue) {
  const item = await fromUuid(itemUuid);
  if (!(item instanceof Item)) return;
  await item.setFlag(MODULE_ID, flagKey, flagValue);
}

/**
 * GM handler: Mirror an actor item to the world Items folder.
 * @param {object} itemData - serialized item data
 * @param {string} actorItemUuid
 * @param {number|null} level
 */
async function _gmMirror(itemData, actorItemUuid, level) {
  const folder = getSpellLevelFolder(level);
  if (!folder) {
    console.warn(`${MODULE_ID} | _gmMirror: folder not found for level ${level}`);
    return;
  }

  let mirrorItem = game.items.find(
    (i) => i.getFlag(MODULE_ID, "mirrorOf") === actorItemUuid
  );

  if (mirrorItem) {
    if ((mirrorItem.folder?.id ?? mirrorItem.folder) !== folder.id) {
      await mirrorItem.update({ folder: folder.id });
    }
    await mirrorItem.update({ name: itemData.name, img: itemData.img });
  } else {
    const mirrorData = foundry.utils.duplicate(itemData);
    delete mirrorData._id;
    mirrorData.folder = folder.id;
    foundry.utils.setProperty(mirrorData, "system.container", null);
    foundry.utils.setProperty(mirrorData, "system.containerId", null);
    foundry.utils.setProperty(mirrorData, `flags.${MODULE_ID}.mirrorOf`, actorItemUuid);
    foundry.utils.setProperty(mirrorData, `flags.${MODULE_ID}.spellLevel`, level);
    await Item.create(mirrorData);
  }
}

/**
 * GM handler: Send a whisper to all GMs.
 * @param {string} message - HTML message content
 */
async function _gmNotify(message) {
  await ChatMessage.create({
    content: `<strong>${MODULE_ID}</strong> | ${message}`,
    whisper: ChatMessage.getWhisperRecipients("GM"),
    speaker: { alias: "Innovations Codex" }
  });
}

/* ================================================== */
/*  SECTION 2: Socketlib wrappers (call from anyone)  */
/* ================================================== */

function _ensureSocket() {
  if (!icSocket) {
    // Last-ditch attempt to register if socketlib is available
    try {
      if (typeof socketlib !== "undefined") _registerSocketlib();
    } catch (e) {
      // Swallow — registration may fail if socket channel not allocated
    }
    if (!icSocket) {
      ui.notifications?.error("Innovations Codex: socketlib is not connected. Please return to the Foundry setup screen and relaunch your world.");
      throw new Error(`${MODULE_ID} | socketlib not initialized. Restart the world from the Foundry setup screen.`);
    }
  }
}

async function addCodexToActor(actorUuid) {
  _ensureSocket();
  return icSocket.executeAsGM("addCodexToActor", actorUuid);
}

async function createInnovationOnActor(actorUuid, codexId, itemName, itemType) {
  _ensureSocket();
  return icSocket.executeAsGM("createInnovation", actorUuid, codexId, itemName, itemType);
}

async function fabricate(ownerActorUuid, targetActorUuid, blueprintUuid, codexUuid, slotLevel) {
  _ensureSocket();
  return icSocket.executeAsGM("fabricate", ownerActorUuid, targetActorUuid, blueprintUuid, codexUuid, slotLevel);
}

async function requestRecall(itemUuid, codexUuid) {
  _ensureSocket();
  return icSocket.executeAsGM("recall", itemUuid, codexUuid);
}

async function setItemFlag(itemUuid, flagKey, flagValue) {
  _ensureSocket();
  return icSocket.executeAsGM("setFlag", itemUuid, flagKey, flagValue);
}

async function mirrorToWorldFolder(actorItem, level) {
  _ensureSocket();
  return icSocket.executeAsGM("mirror", actorItem.toObject(), actorItem.uuid, level);
}

async function requestGMNotification(message) {
  _ensureSocket();
  return icSocket.executeAsGM("notify", message);
}

/* ================================================== */
/*  SECTION 3: Folder & Item Setup (GM only)          */
/* ================================================== */

async function ensureFolderHierarchy() {
  const parentId = (f) => f.folder?.id ?? f.folder ?? null;
  const isFolderEmpty = (f) => {
    return !game.items.some((it) => (it.folder?.id ?? it.folder) === f.id)
      && !game.folders.some((child) => parentId(child) === f.id);
  };

  // Root folder
  const rootCandidates = game.folders.filter(
    (f) => f.name === CODEX_NAME && f.type === "Item" && !parentId(f)
  );

  let rootFolder;
  if (rootCandidates.length >= 1) {
    rootFolder = rootCandidates[0];
    for (let i = 1; i < rootCandidates.length; i++) {
      const dupe = rootCandidates[i];
      if (isFolderEmpty(dupe)) {
        console.log(`${MODULE_ID} | Deleting duplicate empty root folder: ${dupe.id}`);
        await dupe.delete();
      }
    }
  } else {
    rootFolder = await Folder.create({ name: CODEX_NAME, type: "Item", folder: null });
    console.log(`${MODULE_ID} | Created root folder: ${rootFolder.name} (${rootFolder.id})`);
  }

  // Subfolders
  for (const name of SPELL_LEVEL_FOLDERS) {
    const matches = game.folders.filter(
      (f) => f.name === name && f.type === "Item" && parentId(f) === rootFolder.id
    );
    if (matches.length > 1) {
      for (let i = 1; i < matches.length; i++) {
        if (isFolderEmpty(matches[i])) {
          console.log(`${MODULE_ID} | Deleting duplicate empty subfolder "${name}": ${matches[i].id}`);
          await matches[i].delete();
        }
      }
    }
    if (matches.length === 0) {
      const sub = await Folder.create({ name, type: "Item", folder: rootFolder.id });
      console.log(`${MODULE_ID} | Created subfolder: ${sub.name} inside ${rootFolder.name}`);
    }
  }

  // Clean strays at root
  for (const name of SPELL_LEVEL_FOLDERS) {
    const strays = game.folders.filter(
      (f) => f.name === name && f.type === "Item" && !parentId(f)
    );
    for (const stray of strays) {
      if (isFolderEmpty(stray)) {
        console.log(`${MODULE_ID} | Deleting stray root-level folder "${name}": ${stray.id}`);
        await stray.delete();
      }
    }
  }

  return rootFolder;
}

async function ensureWorldItems(rootFolder) {
  const existingFeat = game.items.find((i) => i.getFlag(MODULE_ID, "isCreateFeature"));
  const existingCodex = game.items.find((i) => i.getFlag?.(MODULE_ID, "isCodex"));

  if (existingFeat && existingCodex) return;

  const create = await Dialog.confirm({
    title: "Innovations Codex Setup",
    content: `<p>The Innovations Codex module needs to create its world items. Create them now?</p>`
  });
  if (!create) return;

  if (!existingFeat) {
    const activityId = foundry.utils.randomID();
    await Item.create({
      name: FEAT_NAME,
      type: "feat",
      img: "icons/skills/trades/smithing-anvil-silver-red.webp",
      folder: rootFolder.id,
      system: {
        description: {
          value: `<p>You channel your ingenuity to produce arcane innovations. Use this feature to open your <strong>Innovations Codex</strong> — a personal workshop where you design, categorize, and fabricate magical items.</p>
<p>When you use this feature, your codex is automatically added to your inventory if you don't already have one. From the codex window you can:</p>
<ul>
<li><strong>Create</strong> new innovation blueprints for your DM to review.</li>
<li><strong>Assign spell levels</strong> to approved innovations.</li>
<li><strong>Fabricate</strong> innovations onto yourself or allies by expending a spell slot of the appropriate level.</li>
<li><strong>Recall</strong> fabricated innovations, removing them from their holder.</li>
</ul>
<p>Newly created innovations start as <em>Uncategorized</em> and cannot be fabricated until a spell level is assigned.</p>`
        },
        activities: {
          [activityId]: {
            _id: activityId,
            type: "utility",
            name: "Open Codex",
            activation: { type: "action", value: 1, override: true },
            consumption: { scaling: { allowed: false }, targets: [] },
            duration: { override: false, units: "" },
            range: { override: false },
            target: { override: false, prompt: false },
            uses: { spent: 0, max: "", recovery: [] }
          }
        }
      },
      flags: { [MODULE_ID]: { isCreateFeature: true } }
    });
  }

  if (!existingCodex) {
    await Item.create({
      name: CODEX_NAME,
      type: "container",
      img: "icons/sundries/books/book-symbol-yellow-grey.webp",
      folder: rootFolder.id,
      flags: { [MODULE_ID]: { isCodex: true } }
    });
  }
}

/* ================================================== */
/*  SECTION 4: Helpers                                */
/* ================================================== */

function getSpellLevelFolder(level) {
  const rootFolder = game.folders.find(
    (f) => f.name === CODEX_NAME && f.type === "Item" && !(f.folder?.id ?? f.folder)
  );
  if (!rootFolder) return null;
  const folderName = (level >= 1 && level <= 9)
    ? SPELL_LEVEL_FOLDERS[level]
    : "Uncategorized";
  return game.folders.find(
    (f) => f.name === folderName && f.type === "Item" && (f.folder?.id ?? f.folder) === rootFolder.id
  ) ?? null;
}

function isCodexItem(item) {
  if (!item) return false;
  if (item.getFlag?.(MODULE_ID, "isCodex")) return true;
  return item.type === "container" && item.name === CODEX_NAME;
}

function isCreateFeature(item) {
  if (!item) return false;
  return Boolean(item.getFlag?.(MODULE_ID, "isCreateFeature"));
}

function getSlotLevel(codex, blueprint) {
  if (!codex || !blueprint) return null;
  const uuidMap = codex.getFlag(MODULE_ID, "slotLevelsByUuid") ?? {};
  const nameMap = codex.getFlag(MODULE_ID, "slotLevelsByName") ?? {};
  const fromUuidVal = Number.parseInt(uuidMap[blueprint.uuid ?? blueprint.id], 10);
  if (Number.isFinite(fromUuidVal) && fromUuidVal >= 1 && fromUuidVal <= 9) return fromUuidVal;
  const fromName = Number.parseInt(nameMap[blueprint.name], 10);
  if (Number.isFinite(fromName) && fromName >= 1 && fromName <= 9) return fromName;
  const itemLevel = blueprint.getFlag?.(MODULE_ID, "spellLevel");
  if (itemLevel !== null && itemLevel !== undefined) {
    const parsed = Number.parseInt(itemLevel, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 9) return parsed;
  }
  return null;
}

/**
 * Set the spell level for a blueprint. Updates codex flags, item flag,
 * mirrors to world folder, and notifies GM. All GM operations are routed
 * through socketlib.
 */
async function setSlotLevelForBlueprint(codex, blueprint, level) {
  if (!codex || !blueprint) return;

  const normalizedLevel = (level === null || level === "" || level === "0" || level === 0)
    ? null
    : Number.parseInt(level, 10);
  if (normalizedLevel !== null && (!Number.isFinite(normalizedLevel) || normalizedLevel < 1 || normalizedLevel > 9)) return;

  const blueprintUuid = blueprint.uuid ?? blueprint.id;
  const blueprintName = blueprint.name;

  // Update codex flag maps via GM
  const uuidMap = foundry.utils.duplicate(codex.getFlag(MODULE_ID, "slotLevelsByUuid") ?? {});
  const nameMap = foundry.utils.duplicate(codex.getFlag(MODULE_ID, "slotLevelsByName") ?? {});

  if (normalizedLevel === null) {
    delete uuidMap[blueprintUuid];
    if (blueprintName) delete nameMap[blueprintName];
  } else {
    uuidMap[blueprintUuid] = normalizedLevel;
    if (blueprintName) nameMap[blueprintName] = normalizedLevel;
  }

  await setItemFlag(codex.uuid, "slotLevelsByUuid", uuidMap);
  await setItemFlag(codex.uuid, "slotLevelsByName", nameMap);

  // Update the item's own flag via GM
  await setItemFlag(blueprintUuid, "spellLevel", normalizedLevel);

  // Mirror to world folder
  await mirrorToWorldFolder(blueprint, normalizedLevel);

  // Notify GM
  const actor = codex.parent instanceof Actor ? codex.parent : null;
  const actorName = actor?.name ?? "Unknown Actor";
  const userName = game.user.name ?? "Unknown User";
  const levelLabel = normalizedLevel ? `Level ${normalizedLevel}` : "Uncategorized";
  await requestGMNotification(
    `<strong>${userName}</strong>'s character <strong>${actorName}</strong> assigned <strong>${blueprint.name}</strong> to <strong>${levelLabel}</strong>`
  );
}

function buildSlotOptions(selectedLevel) {
  const options = [{
    value: "0",
    label: "Uncategorized",
    selected: selectedLevel === null || selectedLevel === 0 || selectedLevel === undefined
  }];
  for (let i = 1; i <= 9; i++) {
    options.push({ value: String(i), label: `${i}`, selected: i === selectedLevel });
  }
  return options;
}

function getTargetActors(user) {
  const actors = new Map();
  const ownedLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const mode = getTargetMode();

  if (mode === "pcs") {
    for (const actor of game.actors.contents) {
      if (actor.type === "character") actors.set(actor.uuid, actor);
    }
  } else if (mode === "owned") {
    for (const actor of game.actors.contents) {
      if (user.isGM || actor.testUserPermission(user, ownedLevel)) {
        actors.set(actor.uuid, actor);
      }
    }
  }

  const allowedNames = getAllowedActorNames();
  if (allowedNames.length) {
    for (const actor of game.actors.contents) {
      if (!allowedNames.includes(actor.name.toLowerCase())) continue;
      if (user.isGM || actor.testUserPermission(user, ownedLevel)) {
        actors.set(actor.uuid, actor);
      }
    }
  }

  return Array.from(actors.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((actor) => ({ name: actor.name, img: actor.img, uuid: actor.uuid }));
}

function getAllowedActorNames() {
  const raw = game.settings.get(MODULE_ID, "allowedActorNames");
  if (!raw) return [];
  return raw.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
}

function getTargetMode() {
  return game.settings.get(MODULE_ID, "targetMode") || "pcs";
}

function getIconSize() {
  const raw = game.settings.get(MODULE_ID, "iconSize");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 64;
}

function getPortraitSize() {
  const raw = game.settings.get(MODULE_ID, "portraitSize");
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 48;
}

function getBlueprintItems(actor, codex) {
  return actor.items
    .filter((item) => isItemInCodex(item, codex))
    .map((item) => {
      const level = getSlotLevel(codex, item);
      return {
        name: item.name,
        img: item.img,
        uuid: item.uuid,
        slotLevel: level,
        canFabricate: level !== null && level >= 1 && level <= 9,
        slotOptions: buildSlotOptions(level)
      };
    });
}

function isItemInCodex(item, codex) {
  const container = item?.system?.container;
  const containerId = item?.system?.containerId;
  return (
    container === codex.id ||
    container === codex.uuid ||
    containerId === codex.id ||
    containerId === codex.uuid
  );
}

function getActiveInnovations(codex) {
  if (!codex) return [];
  const results = [];
  for (const actor of game.actors.contents) {
    for (const item of actor.items.contents) {
      if (item.getFlag(MODULE_ID, "originUuid") !== codex.uuid) continue;
      results.push({
        itemName: item.name,
        itemImg: item.img,
        itemUuid: item.uuid,
        actorName: actor.name,
        actorImg: actor.img
      });
    }
  }
  return results;
}

/* ================================================== */
/*  SECTION 5: Player-facing logic                    */
/* ================================================== */

function openCodex(codexItem) {
  if (!codexItem) return;
  const now = Date.now();
  const lastOpen = RECENT_OPEN.get(codexItem.uuid) ?? 0;
  if (now - lastOpen < 250) return;
  RECENT_OPEN.set(codexItem.uuid, now);
  new InnovationsCodexApp(codexItem).render(true);
}

async function openCodexByUuid(itemUuid) {
  const item = await fromUuid(itemUuid);
  if (item) openCodex(item);
}

/**
 * Entry point when "Create Innovation" feat is used.
 * Routes codex creation through socketlib so any player can use it.
 */
async function useCreateFeature(feat) {
  const actor = feat?.parent;
  if (!(actor instanceof Actor)) {
    ui.notifications.warn("The Create Innovation feature must be on an actor's sheet.");
    return;
  }

  // Check if actor already has a codex
  let codex = actor.items.find((i) => isCodexItem(i));

  if (!codex) {
    // Ask GM to add the codex via socketlib
    const codexUuid = await addCodexToActor(actor.uuid);
    if (!codexUuid) {
      ui.notifications.error("Failed to add Innovations Codex to your character.");
      return;
    }
    codex = await fromUuid(codexUuid);
    if (!codex) {
      ui.notifications.error("Failed to find the newly created codex.");
      return;
    }
    ui.notifications.info(`Added ${CODEX_NAME} to ${actor.name}'s inventory.`);
  }

  openCodex(codex);
}

/**
 * Show dialog and create a new innovation via socketlib.
 */
async function createNewInnovation(codex, actor) {
  const itemTypes = {
    weapon: "Weapon",
    equipment: "Equipment",
    consumable: "Consumable",
    tool: "Tool",
    loot: "Loot"
  };

  const typeOptions = Object.entries(itemTypes)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  const content = `
    <form>
      <div class="form-group">
        <label>Innovation Name</label>
        <input type="text" name="itemName" placeholder="Name your innovation..." autofocus />
      </div>
      <div class="form-group">
        <label>Item Type</label>
        <select name="itemType">${typeOptions}</select>
      </div>
    </form>`;

  const result = await Dialog.prompt({
    title: "New Innovation",
    content,
    label: "Create",
    callback: (html) => {
      const form = html[0]?.querySelector("form") ?? html.querySelector?.("form");
      return {
        name: form?.querySelector("[name=itemName]")?.value?.trim(),
        type: form?.querySelector("[name=itemType]")?.value
      };
    },
    rejectClose: false
  });

  if (!result || !result.name) {
    ui.notifications.warn("Innovation name is required.");
    return null;
  }

  // Create item via GM
  const createdUuid = await createInnovationOnActor(actor.uuid, codex.id, result.name, result.type);
  if (!createdUuid) {
    ui.notifications.error("Failed to create innovation.");
    return null;
  }

  const created = await fromUuid(createdUuid);
  if (!created) {
    ui.notifications.error("Failed to find the newly created innovation.");
    return null;
  }

  // Mirror to world Uncategorized folder via GM
  await mirrorToWorldFolder(created, null);

  // Notify GM
  const actorName = actor.name ?? "Unknown Actor";
  const userName = game.user.name ?? "Unknown User";
  await requestGMNotification(
    `<strong>${userName}</strong>'s character <strong>${actorName}</strong> created a new innovation: <strong>${result.name}</strong> (Uncategorized)`
  );

  // Open the item sheet
  created.sheet.render(true);
  return created;
}

/* ================================================== */
/*  SECTION 6: ApplicationV2 Window                   */
/* ================================================== */

class InnovationsCodexApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "innovations-codex-app",
    tag: "section",
    classes: ["innovations-codex"],
    window: { title: "Innovations Codex", resizable: true },
    position: { width: 720 }
  });

  constructor(codex, options = {}) {
    super(options);
    this.codex = codex;
    this.activeTab = options.tab ?? "blueprints";
  }

  get title() {
    return this.codex?.name ?? CODEX_NAME;
  }

  async _prepareContext() {
    const parentActor = this.codex?.parent instanceof Actor ? this.codex.parent : null;
    const blueprints = parentActor ? getBlueprintItems(parentActor, this.codex) : [];
    const targets = getTargetActors(game.user);
    const activeInnovations = getActiveInnovations(this.codex);

    return {
      codexName: this.codex?.name ?? CODEX_NAME,
      codexUuid: this.codex?.uuid,
      hasParent: Boolean(parentActor),
      hasBlueprints: blueprints.length > 0,
      blueprints,
      hasTargets: targets.length > 0,
      targets,
      defaultTarget: targets[0] ?? null,
      hasActive: activeInnovations.length > 0,
      activeInnovations,
      iconSize: getIconSize(),
      portraitSize: getPortraitSize(),
      isBlueprintsTab: this.activeTab === "blueprints",
      isActiveTab: this.activeTab === "active"
    };
  }

  async _renderHTML(context, _options) {
    return renderTemplate(`modules/${MODULE_ID}/templates/innovations-codex.hbs`, context);
  }

  _replaceHTML(result, content, _options) {
    const target = content?.[0] ?? content;
    if (!target) return;
    if (typeof result === "string") { target.innerHTML = result; return; }
    if (result instanceof Node) { target.replaceChildren(result); return; }
    if (result && typeof result === "object" && typeof result.html === "string") {
      target.innerHTML = result.html; return;
    }
  }

  _onRender() {
    this._activateListeners();
  }

  _activateListeners() {
    const appWindow = this.appId
      ? document.querySelector(`.app.window-app[data-appid="${this.appId}"]`)
      : null;
    const root = appWindow?.querySelector(".window-content")
      ?? this.window?.content?.[0]
      ?? this.window?.content
      ?? (this.window?.element?.[0] ?? this.window?.element)
      ?? document.getElementById(this.id)
      ?? this.element?.[0]
      ?? this.element;
    if (!root) return;

    // Tab buttons
    root.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const tab = e.currentTarget.dataset.tab;
        if (tab && tab !== this.activeTab) { this.activeTab = tab; this.render(); }
      });
    });

    // Target portrait swap
    root.querySelectorAll("[data-target-select]").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const row = e.currentTarget.closest("[data-blueprint-uuid]");
        const portrait = row?.querySelector(".ic-target-portrait");
        const option = e.currentTarget.selectedOptions?.[0];
        if (portrait && option?.dataset?.portrait) portrait.src = option.dataset.portrait;
      });
    });

    // Fabricate
    root.querySelectorAll("[data-action='fabricate']").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const row = e.currentTarget.closest("[data-blueprint-uuid]");
        const blueprintUuid = e.currentTarget.dataset.itemUuid ?? row?.dataset.blueprintUuid;
        const select = row?.querySelector("[data-target-select]");
        const targetUuid = select?.value;
        if (!targetUuid) { ui.notifications.warn("Select a target actor first."); return; }
        await this._fabricate(blueprintUuid, targetUuid);
      });
    });

    // Slot level change
    root.querySelectorAll("[data-slot-level]").forEach((sel) => {
      sel.addEventListener("change", async (e) => {
        const row = e.currentTarget.closest("[data-blueprint-uuid]");
        const blueprintUuid = row?.dataset.blueprintUuid;
        if (!blueprintUuid || !this.codex) return;
        const rawValue = e.currentTarget.value;
        const level = rawValue === "0" ? null : Number.parseInt(rawValue, 10);
        const blueprint = await fromUuid(blueprintUuid);
        if (!blueprint) return;
        await setSlotLevelForBlueprint(this.codex, blueprint, level);
        await this.render();
      });
    });

    // Recall
    root.querySelectorAll("[data-action='recall']").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const target = e.currentTarget;
        const itemUuid = target.dataset.itemUuid;
        if (!itemUuid) return;
        target.disabled = true;
        await requestRecall(itemUuid, this.codex?.uuid);
        await this.render();
      });
    });

    // "+ New Innovation"
    const addBtn = root.querySelector("[data-action='add-innovation']");
    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        const actor = this.codex?.parent instanceof Actor ? this.codex.parent : null;
        if (!actor) { ui.notifications.warn("The Codex must be owned by an actor."); return; }
        const created = await createNewInnovation(this.codex, actor);
        if (created) await this.render();
      });
    }
  }

  async _fabricate(blueprintUuid, targetUuid) {
    if (!this.codex) return;
    const blueprint = await fromUuid(blueprintUuid);
    const targetActor = await fromUuid(targetUuid);
    const ownerActor = this.codex.parent instanceof Actor ? this.codex.parent : null;

    if (!(blueprint instanceof Item)) { ui.notifications.error("Blueprint not found."); return; }
    if (!(targetActor instanceof Actor)) { ui.notifications.error("Target actor not found."); return; }
    if (!ownerActor) { ui.notifications.error("The Codex must be owned by an Actor."); return; }

    const slotLevel = getSlotLevel(this.codex, blueprint);
    if (!slotLevel || slotLevel < 1 || slotLevel > 9) {
      ui.notifications.warn("Assign a spell level before fabricating.");
      return;
    }

    const confirmSpend = await Dialog.confirm({
      title: "Consume Spell Slot",
      content: `<p>Consume a level ${slotLevel} spell slot from ${ownerActor.name} to fabricate ${blueprint.name}?</p>`
    });
    if (!confirmSpend) return;

    const slotPath = `system.spells.spell${slotLevel}.value`;
    const currentSlots = foundry.utils.getProperty(ownerActor, slotPath);
    if (!Number.isFinite(currentSlots) || currentSlots <= 0) {
      ui.notifications.warn(`No level ${slotLevel} spell slots available on ${ownerActor.name}.`);
      return;
    }

    // All GM operations via socketlib
    const success = await fabricate(ownerActor.uuid, targetActor.uuid, blueprintUuid, this.codex.uuid, slotLevel);
    if (success) {
      ui.notifications.info(`Fabricated Temporary ${blueprint.name} for ${targetActor.name}.`);
    } else {
      ui.notifications.error("Fabrication failed.");
    }
    await this.render();
  }
}

/* ================================================== */
/*  SECTION 7: Hooks                                  */
/* ================================================== */

// --- Socketlib registration ---
// socketlib.ready may fire before or during init depending on load order.
// We register in both places to handle either case.
Hooks.once("socketlib.ready", () => {
  _registerSocketlib();
});

// --- Settings + API ---
Hooks.once("init", () => {
  // If socketlib.ready already fired before our hook was registered, catch up now
  try {
    if (typeof socketlib !== "undefined") _registerSocketlib();
  } catch (e) {
    console.warn(`${MODULE_ID} | socketlib registration deferred:`, e.message);
  }
  game.settings.register(MODULE_ID, "allowedActorNames", {
    name: "Allowed Actor Names",
    hint: "Comma-separated actor names to include as innovation targets.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(MODULE_ID, "targetMode", {
    name: "Target Actor Filter",
    hint: "Choose which actors appear as fabrication targets.",
    scope: "world", config: true, type: String,
    choices: { pcs: "Player Characters", owned: "All Owned Characters" },
    default: "pcs"
  });

  game.settings.register(MODULE_ID, "iconSize", {
    name: "Item Icon Size",
    hint: "Size (in pixels) for blueprint item icons.",
    scope: "client", config: true, type: String,
    choices: { "64": "64 px", "96": "96 px", "128": "128 px", "256": "256 px" },
    default: "64"
  });

  game.settings.register(MODULE_ID, "portraitSize", {
    name: "Portrait Icon Size",
    hint: "Size (in pixels) for target portraits.",
    scope: "client", config: true, type: String,
    choices: { "32": "32 px", "48": "48 px", "64": "64 px", "96": "96 px" },
    default: "48"
  });

  const moduleApi = game.modules.get(MODULE_ID);
  if (moduleApi) {
    moduleApi.api = {
      openCodex: openCodexByUuid,
      useCreateFeature: async (featUuid) => {
        const feat = await fromUuid(featUuid);
        if (feat) await useCreateFeature(feat);
      }
    };
  }
});

// --- GM setup on ready ---
Hooks.once("ready", async () => {
  if (game.user.isGM) {
    const rootFolder = await ensureFolderHierarchy();
    await ensureWorldItems(rootFolder);
  }
});

// --- Feat usage hook ---
Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
  const item = activity?.item;
  if (!isCreateFeature(item)) return;

  // Suppress the activity dialog and chat message
  if (dialogConfig) dialogConfig.configure = false;
  if (messageConfig) messageConfig.create = false;

  useCreateFeature(item);
  return false;
});

// --- Hotbar macro ---
Hooks.on("hotbarDrop", async (bar, data, slot) => {
  if (data?.type !== "Item" || !data?.uuid) return;
  const item = await fromUuid(data.uuid);

  if (isCreateFeature(item)) {
    const command = `game.modules.get("${MODULE_ID}").api.useCreateFeature("${item.uuid}")`;
    const macro = await Macro.create({ name: "Create Innovation", type: "script", img: item.img, command });
    await game.user.assignHotbarMacro(macro, slot);
    return false;
  }

  if (isCodexItem(item)) {
    const command = `game.modules.get("${MODULE_ID}").api.openCodex("${item.uuid}")`;
    const macro = await Macro.create({ name: "Open Innovations Codex", type: "script", img: item.img, command });
    await game.user.assignHotbarMacro(macro, slot);
    return false;
  }
});
