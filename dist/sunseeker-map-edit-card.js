'use strict';

// ─── Region type visual / meta configuration ─────────────────────────────────
const REGION_CONFIG = {
  region_work: {
    fill: 'rgba(34,139,34,0.40)',
    stroke: '#7CFC00',
    selFill: 'rgba(50,200,50,0.65)',
    label: 'Work Zone',
    icon: '🌱',
    effective_area: 'INNER',
  },
  region_channel: {
    fill: 'rgba(160,160,160,0.45)',
    stroke: '#b0b0b0',
    selFill: 'rgba(200,200,200,0.65)',
    label: 'Passage',
    icon: '↔️',
    effective_area: 'INNER',
  },
  region_forbidden: {
    fill: 'rgba(40,40,40,0.80)',
    stroke: '#888',
    selFill: 'rgba(90,90,90,0.90)',
    label: 'Forbidden',
    icon: '🚫',
    effective_area: 'OUTER',
  },
  region_obstacle: {
    fill: 'rgba(240,128,128,0.50)',
    stroke: '#F08080',
    selFill: 'rgba(240,80,80,0.70)',
    label: 'Obstacle',
    icon: '⛔',
    effective_area: 'OUTER',
  },
  region_placed_blank: {
    fill: 'rgba(0,100,255,0.15)',
    stroke: '#4499ff',
    selFill: 'rgba(0,130,255,0.35)',
    label: 'Safe zones',
    icon: '⬜',
    effective_area: 'INNER',
  },
  region_charger_channel: {
    fill: 'rgba(255,200,0,0.35)',
    stroke: '#FFD700',
    selFill: 'rgba(255,225,0,0.55)',
    label: 'Charger Channel',
    icon: '⚡',
    effective_area: 'INNER',
  },
};

const EDITABLE   = ['region_work', 'region_channel', 'region_forbidden', 'region_obstacle', 'region_placed_blank'];
const DRAWABLE   = ['region_forbidden', 'region_placed_blank', 'region_obstacle', 'region_channel'];
const MODIFIABLE = ['region_channel', 'region_forbidden', 'region_placed_blank'];
const DELETABLE  = [...EDITABLE];
const ALL_TYPES  = [...EDITABLE, 'region_charger_channel'];
const DRAW_ORDER = ['region_work', 'region_charger_channel', 'region_channel', 'region_placed_blank', 'region_forbidden', 'region_obstacle'];
const HIT_ORDER  = ['region_obstacle', 'region_forbidden', 'region_placed_blank', 'region_channel', 'region_charger_channel', 'region_work'];
const MAP_ATTR_PRIORITY = ['map_data', 'map', 'map_json', 'mapfile', 'raw_map_data', 'json'];
const SERVICE_DOMAIN = 'sunseeker';
const SERVICE_SET_MAP = 'set_map';
const SERVICE_RESTORE_MAP = 'restore_map';
const SERVICE_BACKUP_MAP = 'backup_map';
const SERVICE_DELETE_BACKUP = 'delete_backup';

// ─── Utilities ────────────────────────────────────────────────────────────────
function parsePoints(str) {
  if (Array.isArray(str)) return str.map(p => [Number(p[0]), Number(p[1])]);
  if (typeof str === 'string') {
    try { return JSON.parse(str).map(p => [Number(p[0]), Number(p[1])]); } catch { return []; }
  }
  return [];
}

function stringifyPoints(pts) {
  return JSON.stringify(pts.map(([x, y]) => [
    Math.round(x * 1000) / 1000,
    Math.round(y * 1000) / 1000,
  ]));
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Card ─────────────────────────────────────────────────────────────────────
class SunseekerMapEditCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Data
    this._mapData    = null;
    this._filename   = 'map.json';
    this._regions    = {};       // type → array of region objects (with _parsedPoints)

    // Selection / interaction
    this._selType    = null;
    this._selId      = null;
    this._mode       = 'select';   // 'select' | 'draw' | 'delete'
    this._drawType   = 'region_obstacle';
    this._drawPts    = [];         // points being placed
    this._drawShape  = 'polygon';  // 'polygon' | 'circle' | 'ellipse'
    this._drawAnchor = null;       // map coords for circle center / ellipse first corner
    this._mouseMap   = null;       // current mouse position in map coords

    // View transform (zoom around centre + pan offset in canvas px)
    this._zoom  = 1.0;
    this._panX  = 0;
    this._panY  = 0;
    this._bounds = { minX: -20, maxX: 20, minY: -20, maxY: 20 };

    // Drag state
    this._drag = null;
    // { type:'pan', sx,sy,spx,spy }
    // { type:'vertex', vi, orig[] }
    // { type:'move', smx,smy, orig[] }

    // Unique ID counter offset (so two regions created in same ms get unique IDs)
    this._idOffset = 0;

    // Undo stack for region deletions (max 20 entries)
    this._deletedStack = [];

    // Guard against stale HA attribute echoes right after submit.
    this._ignoreEntityMapUntil = 0;
    this._submittedMapSignature = null;
    this._postSubmitRefreshTimer = null;

    // Backup panel state
    this._backupSig = '';

    // Merge workflow state
    this._hasLocalEdits = false;
    this._mergeIds = []; // two selected region_work ids to merge

    // Split workflow state
    this._splitRegionId  = null;  // selected work zone id
    this._splitLinePts   = [];    // polyline points being drawn / finalized
    this._splitPending   = false; // line finished, awaiting submit

    this._buildUI();
  }

  // ── Lovelace API ─────────────────────────────────────────────────────────────
  static getConfigElement() {
    return document.createElement('sunseeker-map-edit-card-editor');
  }

  static getStubConfig() {
    return { entity: '', attribute: '', debug: false, backup_panel_position: 'bottom' };
  }

  setConfig(config) {
    this._config = config || {};
    // Reset entity-load tracker so a new entity selection reloads
    this._lastEntityKey = null;
    this._applyConfigUi();
  }

  set hass(hass) {
    this._hass = hass;
    this._tryLoadFromEntity();
  }

  _tryLoadFromEntity() {
    if (!this._hass || !this._config?.entity) return;
    const entity    = this._config.entity;
    const attribute = this._config.attribute;
    const stateObj  = this._hass.states[entity];
    if (!stateObj) return;

    this._renderBackupPanel(stateObj.attributes);

    // Find map attribute: prefer configured one, then first large object/string attr
    let raw;
    let attrName = attribute || '';
    if (attribute && attribute in stateObj.attributes) {
      raw = stateObj.attributes[attribute];
    } else {
      const keys = Object.keys(stateObj.attributes);
      const candidate =
        MAP_ATTR_PRIORITY.find(k => keys.includes(k)) ||
        keys.find(k => {
          const v = stateObj.attributes[k];
          if (typeof v === 'object' && v !== null) return 'region_work' in v;
          if (typeof v === 'string' && v.includes('region_work')) return true;
          return false;
        });
      if (!candidate) return;
      attrName = candidate;
      raw = stateObj.attributes[candidate];
    }

    // Reload based on actual selected attribute value to avoid stale timestamp-only dedupe.
    const rawSignature =
      typeof raw === 'string'
        ? raw
        : JSON.stringify(raw ?? null);

    // Ignore stale entity payloads for a short period after submit.
    if (
      this._submittedMapSignature &&
      Date.now() < this._ignoreEntityMapUntil &&
      rawSignature !== this._submittedMapSignature
    ) {
      return;
    }

    const key = entity + '|' + attrName + '|' + rawSignature;
    if (key === this._lastEntityKey) return;
    this._lastEntityKey = key;

    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      this._loadMapData(data, `${entity}`);
    } catch (e) {
      this._status(`❌ Entity map parse error: ${e.message}`);
    }
  }

  connectedCallback() {
    this._kbHandler = e => this._onKeyDown(e);
    document.addEventListener('keydown', this._kbHandler);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._kbHandler);
    if (this._postSubmitRefreshTimer) {
      clearTimeout(this._postSubmitRefreshTimer);
      this._postSubmitRefreshTimer = null;
    }
  }

  // ── UI Construction ───────────────────────────────────────────────────────────
  _buildUI() {
    this.shadowRoot.innerHTML = `
<style>
:host { display: block; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }

.card {
  background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
  border-radius: var(--ha-card-border-radius, 12px);
  box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.4));
  overflow: hidden;
  color: var(--primary-text-color, #e1e1e1);
  user-select: none;
}

/* ── Toolbar ── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  background: var(--app-header-background-color, #111);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-wrap: wrap;
}
.tsep { width:1px; height:26px; background:rgba(255,255,255,0.15); margin:0 3px; flex-shrink:0; }

.btn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.07);
  color: var(--primary-text-color, #e1e1e1);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: background 0.12s;
  line-height: 1.4;
}
.btn:hover  { background: rgba(255,255,255,0.17); }
.btn.active { background: var(--primary-color, #03A9F4); border-color: transparent; color: #fff; }
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: rgba(127,127,127,0.10);
  border-color: rgba(127,127,127,0.25);
}
.btn.del    { border-color: rgba(255,80,80,0.35); }
.btn.del.active { background: rgba(200,40,40,0.8); border-color: transparent; }
.btn.save   { background: rgba(34,140,34,0.7); border-color: rgba(80,220,80,0.4); color: #fff; font-weight: 600; }
.btn.save:hover { background: rgba(34,165,34,0.9); }
.btn.submit { background: rgba(3,120,220,0.78); border-color: rgba(90,170,240,0.5); color: #fff; font-weight: 600; }
.btn.submit:hover { background: rgba(3,140,235,0.92); }

.workflow-status {
  margin-left: auto;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
  border: 1px solid rgba(255,255,255,0.20);
  background: rgba(127,127,127,0.18);
  color: var(--primary-text-color, #e1e1e1);
  white-space: nowrap;
}
.workflow-status.clean {
  border-color: rgba(80,220,120,0.45);
  background: rgba(35,130,65,0.35);
}
.workflow-status.edited {
  border-color: rgba(255,190,80,0.5);
  background: rgba(165,105,25,0.35);
}
.workflow-status.merge {
  border-color: rgba(90,170,240,0.55);
  background: rgba(35,95,155,0.40);
}

select.dt {
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.28);
  color: var(--primary-text-color, #f3f3f3);
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
}
select.dt option {
  background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
  color: var(--primary-text-color, #f3f3f3);
}

/* ── Main area ── */
.main { display: flex; height: 540px; }

.workarea { display: block; }

.canvas-area {
  flex: 1;
  position: relative;
  background: #0d200d;
  overflow: hidden;
}
canvas { display: block; width: 100%; height: 100%; }

.draw-hint {
  display: none;
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.75);
  color: #fff;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 11px;
  pointer-events: none;
  white-space: nowrap;
}
.draw-hint.on { display: block; }

/* ── Sidebar ── */
.sidebar {
  width: 215px;
  flex-shrink: 0;
  background: var(--secondary-background-color, #1a1a1a);
  border-left: 1px solid var(--divider-color, rgba(0,0,0,0.15));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sb-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 6px;
}
.grp-hdr {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 10px 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .7px;
  text-transform: uppercase;
  color: var(--secondary-text-color, #5f6368);
  cursor: default;
}
.grp-hdr .dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.grp-hdr .cnt {
  margin-left: auto;
  background: rgba(127,127,127,0.20);
  color: var(--primary-text-color, #111);
  border-radius: 8px;
  padding: 1px 6px;
  font-size: 10px;
}
.grp-hdr .addbtn {
  background: none; border: none;
  color: var(--secondary-text-color, #5f6368);
  cursor: pointer; font-size: 15px; padding: 0 1px; line-height:1;
}
.grp-hdr .addbtn:hover { color: var(--primary-text-color, #111); }

.ri {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px 5px 22px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  margin: 1px 4px;
  color: var(--primary-text-color, #111);
}
.ri:hover { background: rgba(127,127,127,0.18); }
.ri.sel   { background: rgba(3,169,244,0.20); }
.ri .rn   { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ri .rname {
  width: 100%;
  box-sizing: border-box;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border: 1px solid var(--divider-color, rgba(0,0,0,0.25));
  border-radius: 4px;
  color: var(--primary-text-color, #111);
  padding: 2px 6px;
  font-size: 12px;
}
.ri .rname:focus {
  outline: 2px solid var(--primary-color, #03A9F4);
  outline-offset: 0;
}
.ri .rdel {
  visibility: hidden;
  background: none; border: none;
  color: var(--error-color, #db4437); cursor: pointer;
  font-size: 13px; padding: 0 2px; flex-shrink:0;
}
.ri:hover .rdel { visibility: visible; }

/* ── Properties ── */
.props {
  border-top: 1px solid var(--divider-color, rgba(0,0,0,0.15));
  padding: 8px;
  font-size: 12px;
  display: none;
}
.props h4 { margin: 0 0 6px; font-size: 11px; font-weight: 700; color: var(--secondary-text-color, #5f6368); text-transform:uppercase; letter-spacing:.5px; }
.props label { display:block; font-size:10px; color: var(--secondary-text-color, #5f6368); margin-top:6px; margin-bottom:2px; text-transform:uppercase; letter-spacing:.4px; }
.props input[type=text],
.props input[type=number] {
  width: 100%; box-sizing: border-box;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border: 1px solid var(--divider-color, rgba(0,0,0,0.25));
  border-radius: 4px;
  color: var(--primary-text-color, #111);
  padding: 4px 6px; font-size: 12px;
}
.props input[readonly] {
  background: rgba(127,127,127,0.08);
  color: var(--secondary-text-color, #5f6368);
  cursor: default;
}
.props .pts-info { color: var(--secondary-text-color, #5f6368); font-size:11px; margin-top:6px; }

/* ── Status bar ── */
.statusbar {
  padding: 3px 12px;
  font-size: 11px;
  color: rgba(255,255,255,0.4);
  background: rgba(0,0,0,0.25);
  border-top: 1px solid rgba(255,255,255,0.05);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Backup panel ── */
.backup-wrap {
  border-top: 1px solid var(--divider-color, rgba(0,0,0,0.15));
  background: var(--secondary-background-color, #1a1a1a);
  padding: 10px;
}
.backup-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.backup-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .4px;
  color: var(--secondary-text-color, #5f6368);
  text-transform: uppercase;
}
.backup-sub {
  font-size: 11px;
  color: var(--secondary-text-color, #7a7a7a);
}
.backup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
}
.backup-item {
  border: 1px solid var(--divider-color, rgba(127,127,127,0.30));
  border-radius: 8px;
  overflow: hidden;
  background: rgba(127,127,127,0.08);
}
.backup-item.current {
  border-color: var(--primary-color, #03A9F4);
  box-shadow: inset 0 0 0 1px rgba(3,169,244,0.35);
}
.backup-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 10px;
  font-weight: 700;
  background: var(--primary-color, #03A9F4);
  color: #fff;
  border-radius: 10px;
  padding: 2px 6px;
  letter-spacing: .2px;
}
.backup-thumb {
  width: 100%;
  height: 80px;
  object-fit: contain;
  background: transparent;
  display: block;
}
.backup-thumb-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.25);
}
.backup-meta {
  padding: 6px;
  font-size: 11px;
  color: var(--primary-text-color, #e1e1e1);
}
.backup-meta .dim {
  color: var(--secondary-text-color, #8f8f8f);
}
.backup-actions {
  display: flex;
  gap: 6px;
  padding: 0 6px 6px;
}
.backup-empty {
  font-size: 12px;
  color: var(--secondary-text-color, #8f8f8f);
  padding: 6px 2px;
}

/* Right-side backup panel mode */
.card.backup-right .workarea {
  display: flex;
  height: 540px;
}
.card.backup-right .main {
  flex: 1;
  height: 100%;
}
.card.backup-right .backup-wrap {
  width: 270px;
  border-top: none;
  border-left: 1px solid var(--divider-color, rgba(0,0,0,0.15));
  overflow-y: auto;
}
.card.backup-right .backup-grid {
  grid-template-columns: 1fr;
}
.card.backup-right .backup-thumb {
  height: 140px;
}

/* Left-side backup panel mode */
.card.backup-left .workarea {
  display: flex;
  height: 540px;
  flex-direction: row-reverse;
}
.card.backup-left .main {
  flex: 1;
  height: 100%;
}
.card.backup-left .backup-wrap {
  width: 270px;
  border-top: none;
  border-right: 1px solid var(--divider-color, rgba(0,0,0,0.15));
  overflow-y: auto;
}
.card.backup-left .backup-grid {
  grid-template-columns: 1fr;
}
.card.backup-left .backup-thumb {
  height: 140px;
}

/* ── Confirm dialog ── */
.dlg-backdrop {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 30;
}
.dlg-backdrop.open { display: flex; }
.dlg {
  width: min(420px, calc(100% - 24px));
  border-radius: 12px;
  background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
  color: var(--primary-text-color, #e1e1e1);
  border: 1px solid var(--divider-color, rgba(127,127,127,0.35));
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
}
.dlg-hd {
  padding: 14px 16px 8px;
  font-size: 18px;
  font-weight: 500;
}
.dlg-bd {
  padding: 0 16px 14px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--secondary-text-color, #b8b8b8);
}
.dlg-ft {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px 12px;
}
.dlg-btn {
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  color: var(--primary-text-color, #e1e1e1);
  background: transparent;
}
.dlg-btn:hover { background: rgba(127,127,127,0.15); }
.dlg-btn.primary {
  color: var(--primary-color, #03A9F4);
  font-weight: 600;
}

input[type=file] { display: none; }

::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 3px; }
</style>

<div class="card">

  <!-- Toolbar -->
  <div class="toolbar">
    <div id="debug-import-group" style="display:flex;gap:4px;align-items:center">
      <input type="file" id="fi" accept=".json">
      <button class="btn" id="import-btn">📂 Import</button>
    </div>
    <div class="tsep" id="debug-import-sep"></div>
    <button class="btn active" id="mode-select" title="Select / Move — S">↖ Select</button>
    <button class="btn" id="mode-merge" title="Select exactly two adjacent work zones to merge">🔗 Merge</button>
    <button class="btn" id="mode-split" title="Draw a split line across one work zone">✂ Split</button>
    <button class="btn del"    id="mode-delete" title="Click to delete region — D">🗑 Delete</button>
    <button class="btn" id="mode-draw"   title="Draw new region — W">✏ Draw</button>
    <div class="tsep"></div>
    <select class="dt" id="draw-type">
      <option value="region_forbidden">🚫 Forbidden</option>
      <option value="region_placed_blank">⬜ Safe zone</option>
      <option value="region_obstacle">⛔ Obstacle</option>
      <option value="region_channel">↔️ Passage</option>
    </select>
    <button class="btn shape-btn active" id="shape-polygon" title="Draw polygon — click to place vertices">⬡ Poly</button>
    <button class="btn shape-btn" id="shape-circle"  title="Draw circle — click-drag from center">○ Circle</button>
    <button class="btn shape-btn" id="shape-ellipse" title="Draw ellipse — click-drag bounding box">⬭ Ellipse</button>
    <button class="btn" id="btn-undo"    title="Undo last draw point — Z  |  Undo last delete — Ctrl+Z">⎌ Undo</button>
    <button class="btn" id="btn-finish"  title="Finish polygon — Enter">✓ Done</button>
    <button class="btn" id="btn-cancel"  title="Cancel drawing — Esc">✗ Cancel</button>
    <div class="tsep"></div>
    <button class="btn" id="btn-fit"     title="Fit all regions to view — F">⊡ Fit</button>
    <button class="btn save" id="save-btn">💾 Save JSON</button>
    <button class="btn" id="reload-btn" title="Clear all edits and reload from entity attribute — Shift+R">🔄 Reset</button>
    <button class="btn submit" id="submit-btn" title="Call sunseeker.set_map with current map data">☁ Submit Map</button>
    <span class="workflow-status clean" id="workflow-status" title="Edit and merge workflow state">State: Clean</span>
  </div>

  <!-- Work area -->
  <div class="workarea">
    <!-- Main -->
    <div class="main">
      <div class="canvas-area" id="ca">
        <canvas id="mc"></canvas>
        <div class="draw-hint" id="hint">
          Click to add points &nbsp;·&nbsp; Click first point or Enter to finish &nbsp;·&nbsp; Right-click / Esc to cancel &nbsp;·&nbsp; Z to undo
        </div>
      </div>
      <div class="sidebar">
        <div class="sb-list" id="sb"></div>
        <div class="props" id="props"></div>
      </div>
    </div>

    <div class="backup-wrap">
      <div class="backup-hd">
        <div>
          <div class="backup-title">Map Backups</div>
          <div class="backup-sub" id="backup-sub">No backup data available</div>
        </div>
        <button class="btn" id="backup-btn" title="Create backup from current map id">🗂 Backup Current</button>
      </div>
      <div class="backup-grid" id="backup-grid"></div>
    </div>
  </div>

  <div class="statusbar" id="st">No map loaded — use Import to open a map JSON file.</div>

  <div class="dlg-backdrop" id="confirm-dlg" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="dlg">
      <div class="dlg-hd" id="confirm-title">Confirm</div>
      <div class="dlg-bd" id="confirm-msg"></div>
      <div class="dlg-ft">
        <button class="dlg-btn" id="confirm-cancel" type="button">Cancel</button>
        <button class="dlg-btn primary" id="confirm-ok" type="button">Submit</button>
      </div>
    </div>
  </div>
</div>`;

    // Refs
    this._canvas   = this.shadowRoot.getElementById('mc');
    this._ctx      = this._canvas.getContext('2d');
    this._ca       = this.shadowRoot.getElementById('ca');
    this._sb       = this.shadowRoot.getElementById('sb');
    this._props    = this.shadowRoot.getElementById('props');
    this._hint     = this.shadowRoot.getElementById('hint');
    this._stbar    = this.shadowRoot.getElementById('st');
    this._backupSub = this.shadowRoot.getElementById('backup-sub');
    this._backupGrid = this.shadowRoot.getElementById('backup-grid');
    this._backupBtn = this.shadowRoot.getElementById('backup-btn');
    this._confirmDlg = this.shadowRoot.getElementById('confirm-dlg');
    this._confirmTitle = this.shadowRoot.getElementById('confirm-title');
    this._confirmMsg = this.shadowRoot.getElementById('confirm-msg');
    this._confirmOk = this.shadowRoot.getElementById('confirm-ok');
    this._confirmCancel = this.shadowRoot.getElementById('confirm-cancel');
    this._workflowStatus = this.shadowRoot.getElementById('workflow-status');

    this._applyConfigUi();

    // Toolbar buttons
    this.shadowRoot.getElementById('import-btn').onclick = () => this.shadowRoot.getElementById('fi').click();
    this.shadowRoot.getElementById('fi').addEventListener('change', e => this._loadFile(e));
    this.shadowRoot.getElementById('mode-select').onclick = () => this._setMode('select');
    this.shadowRoot.getElementById('mode-merge').onclick  = () => this._setMode('merge');
    this.shadowRoot.getElementById('mode-split').onclick  = () => this._setMode('split');
    this.shadowRoot.getElementById('mode-draw').onclick   = () => this._setMode('draw');
    this.shadowRoot.getElementById('mode-delete').onclick = () => this._setMode('delete');
    this.shadowRoot.getElementById('btn-undo').onclick    = () => {
      if (this._mode === 'draw') this._undoPoint();
      else if (this._mode === 'split') this._undoSplitPoint();
      else if (this._mode === 'delete') this._undoDelete();
    };
    this.shadowRoot.getElementById('btn-finish').onclick  = () => {
      if (this._mode === 'split') this._finishSplit();
      else this._finishDraw();
    };
    this.shadowRoot.getElementById('btn-cancel').onclick  = () => this._cancelDraw();
    this.shadowRoot.getElementById('btn-fit').onclick     = () => { this._resetView(); this._redraw(); };
    this.shadowRoot.getElementById('submit-btn').onclick  = () => this._submitMap();
    this.shadowRoot.getElementById('save-btn').onclick    = () => this._save();
    this.shadowRoot.getElementById('reload-btn').onclick  = () => this._resetAndReload();
    this.shadowRoot.getElementById('backup-btn').onclick  = () => this._backupCurrentMap();
    this.shadowRoot.getElementById('draw-type').onchange  = e => { this._drawType = e.target.value; };
    ['polygon', 'circle', 'ellipse'].forEach(s => {
      const btn = this.shadowRoot.getElementById(`shape-${s}`);
      if (btn) btn.onclick = () => this._setDrawShape(s);
    });
    this._updateActionButtons();
    this._updateWorkflowStatus();

    this._renderBackupPanel();

    // Canvas events
    this._canvas.addEventListener('mousedown',    e => this._onDown(e));
    this._canvas.addEventListener('mousemove',    e => this._onMove(e));
    this._canvas.addEventListener('mouseup',      e => this._onUp(e));
    this._canvas.addEventListener('mouseleave',   () => { this._mouseMap = null; this._drag = null; this._drawAnchor = null; });
    this._canvas.addEventListener('dblclick',     e => this._onDbl(e));
    this._canvas.addEventListener('wheel',        e => this._onWheel(e), { passive: false });
    this._canvas.addEventListener('contextmenu',  e => { e.preventDefault(); this._cancelDraw(); });

    // Initial size + watch resizes
    requestAnimationFrame(() => { this._resize(); this._redraw(); });
    if (window.ResizeObserver) {
      new ResizeObserver(() => { this._resize(); this._redraw(); }).observe(this._ca);
    }
  }

  _resize() {
    const r = this._ca.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this._canvas.width  = r.width;
      this._canvas.height = r.height;
    }
  }

  _applyConfigUi() {
    // Can be called before UI is built.
    if (!this.shadowRoot) return;

    const cardEl = this.shadowRoot.querySelector('.card');
    if (cardEl) {
      const pos = this._config?.backup_panel_position;
      cardEl.classList.remove('backup-right', 'backup-left');
      if (pos === 'right') cardEl.classList.add('backup-right');
      if (pos === 'left') cardEl.classList.add('backup-left');
    }

    // Debug-only toolbar controls
    const debug = !!this._config?.debug;
    const importGroup = this.shadowRoot.getElementById('debug-import-group');
    const importSep = this.shadowRoot.getElementById('debug-import-sep');
    const saveBtn = this.shadowRoot.getElementById('save-btn');
    if (importGroup) importGroup.style.display = debug ? 'flex' : 'none';
    if (importSep) importSep.style.display = debug ? 'block' : 'none';
    if (saveBtn) saveBtn.style.display = debug ? 'inline-block' : 'none';
  }

  // ── File loading ─────────────────────────────────────────────────────────────
  _loadFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    ev.target.value = '';
    const reader = new FileReader();
    reader.onload = e => {
      try {
        this._loadMapData(JSON.parse(e.target.result), file.name);
      } catch (err) {
        this._status(`❌ Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  _loadMapData(data, filename) {
    this._mapData  = JSON.parse(JSON.stringify(data));
    this._filename = filename || 'map.json';
    this._regions  = {};
    for (const t of ALL_TYPES) {
      this._regions[t] = (data[t] || []).map(r => {
        const region = {
          ...r,
          _parsedPoints: parsePoints(r.points),
        };
        if (t === 'region_work' && typeof region.name !== 'string') region.name = '';
        return region;
      });
    }
    this._selType = null;
    this._selId   = null;
    this._drawPts = [];
    this._mergeIds = [];
    this._hasLocalEdits = false;
    this._splitRegionId = null;
    this._splitLinePts  = [];
    this._splitPending  = false;
    this._computeBounds();
    this._resetView();
    this._redraw();
    this._renderSidebar();
    this._renderProps();
    const total = EDITABLE.reduce((s, t) => s + (this._regions[t] || []).length, 0);
    this._updateWorkflowStatus();
    this._status(`✅ Loaded: ${filename}  (${total} editable regions)`);
  }

  // ── Coordinate transform ──────────────────────────────────────────────────────
  _computeBounds() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const upd = (x, y) => {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    };
    for (const t of ALL_TYPES) {
      for (const r of (this._regions[t] || [])) {
        for (const [x, y] of r._parsedPoints) upd(x, y);
      }
    }
    if (this._mapData?.charge_pos?.point) upd(...this._mapData.charge_pos.point.slice(0, 2));
    if (!isFinite(x0)) { x0 = -20; x1 = 20; y0 = -20; y1 = 20; }
    const px = Math.max((x1 - x0) * 0.06, 0.5);
    const py = Math.max((y1 - y0) * 0.06, 0.5);
    this._bounds = { minX: x0 - px, maxX: x1 + px, minY: y0 - py, maxY: y1 + py };
  }

  _resetView() { this._zoom = 1; this._panX = 0; this._panY = 0; }

  _getViewTransform() {
    const { minX, maxX, minY, maxY } = this._bounds;
    const cw = this._canvas.width;
    const ch = this._canvas.height;
    const rangeX = Math.max(maxX - minX, 1e-9);
    const rangeY = Math.max(maxY - minY, 1e-9);
    const scale = Math.min(cw / rangeX, ch / rangeY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { cw, ch, scale, cx, cy };
  }

  // map → canvas pixel
  _m2c(mx, my) {
    const { cw, ch, scale, cx, cy } = this._getViewTransform();
    const bx = (mx - cx) * scale;
    const by = (cy - my) * scale;
    return [
      bx * this._zoom + cw / 2 + this._panX,
      by * this._zoom + ch / 2 + this._panY,
    ];
  }

  // canvas pixel → map
  _c2m(cx, cy) {
    const { cw, ch, scale, cx: mapCx, cy: mapCy } = this._getViewTransform();
    const bx = (cx - cw / 2 - this._panX) / this._zoom;
    const by = (cy - ch / 2 - this._panY) / this._zoom;
    return [
      mapCx + bx / scale,
      mapCy - by / scale,
    ];
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────
  _redraw() {
    if (!this._ctx) return;
    const ctx = this._ctx;
    const cw = this._canvas.width, ch = this._canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // Background
    ctx.fillStyle = '#0d200d';
    ctx.fillRect(0, 0, cw, ch);

    if (!this._mapData) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Import a map JSON file to begin editing', cw / 2, ch / 2);
      ctx.textAlign = 'left';
      return;
    }

    // Draw grid (light)
    this._drawGrid(ctx, cw, ch);

    // Regions
    for (const t of DRAW_ORDER) {
      const cfg = REGION_CONFIG[t];
      if (!cfg || !this._regions[t]) continue;
      for (const r of this._regions[t]) {
        const sel = r.id === this._selId && t === this._selType;
        this._drawPoly(ctx, r._parsedPoints, sel ? cfg.selFill : cfg.fill, sel ? '#fff' : cfg.stroke, sel);
        if (t === 'region_work' && r.name) this._drawLabel(ctx, r._parsedPoints, r.name, cfg.stroke);
      }
    }

    // Charger pin
    if (this._mapData.charge_pos?.point) {
      const [mx, my] = this._mapData.charge_pos.point;
      const [px, py] = this._m2c(mx, my);
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD700';
      ctx.fill();
      ctx.strokeStyle = '#FFA500';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚡', px, py);
      ctx.textAlign = 'left';
    }

    // In-progress drawing (polygon / circle / ellipse)
    if (this._mode === 'draw') {
      if (this._drawShape === 'circle' && this._drawAnchor && this._mouseMap) {
        this._drawInProgressCircle(ctx);
      } else if (this._drawShape === 'ellipse' && this._drawAnchor && this._mouseMap) {
        this._drawInProgressEllipse(ctx);
      } else if (this._drawShape === 'polygon' && this._drawPts.length > 0) {
        this._drawInProgress(ctx);
      }
    }

    // Split overlay (highlight target zone + draw split polyline)
    if ((this._mode === 'split' || this._splitPending) && this._splitRegionId) {
      const sr = this._getRegion('region_work', this._splitRegionId);
      if (sr) {
        // Highlight the zone
        this._drawPoly(ctx, sr._parsedPoints, 'rgba(255,220,0,0.25)', '#FFD700', false);
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        const [fx, fy] = this._m2c(...sr._parsedPoints[0]);
        ctx.beginPath(); ctx.moveTo(fx, fy);
        for (let i = 1; i < sr._parsedPoints.length; i++) {
          const [px, py] = this._m2c(...sr._parsedPoints[i]); ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.stroke();
      }
      const pts = this._splitLinePts;
      if (pts.length > 0) {
        ctx.setLineDash([7, 4]);
        ctx.strokeStyle = '#FF6600';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const [fx, fy] = this._m2c(...pts[0]); ctx.moveTo(fx, fy);
        for (let i = 1; i < pts.length; i++) {
          const [px, py] = this._m2c(...pts[i]); ctx.lineTo(px, py);
        }
        if (this._mode === 'split' && !this._splitPending && this._mouseMap) {
          const [mx, my] = this._m2c(...this._mouseMap); ctx.lineTo(mx, my);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Vertex dots
        for (let i = 0; i < pts.length; i++) {
          const [px, py] = this._m2c(...pts[i]);
          ctx.fillStyle = i === 0 ? '#fff' : '#FF6600';
          ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
        }
        // Point counter
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '11px sans-serif';
        const [lx, ly] = this._m2c(...pts[pts.length - 1]);
        ctx.fillText(`${pts.length} pt${pts.length > 1 ? 's' : ''}`, lx + 8, ly - 6);
      }
    }

    // Vertex handles on selected region
    if (this._selId && MODIFIABLE.includes(this._selType)) {
      const r = this._selRegion();
      if (r) this._drawHandles(ctx, r._parsedPoints);
    }

    // Coordinate overlay (bottom-right)
    if (this._mouseMap) {
      const [mx, my] = this._mouseMap;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cw - 160, ch - 22, 158, 18);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`x:${mx.toFixed(3)}  y:${my.toFixed(3)}`, cw - 6, ch - 9);
      ctx.textAlign = 'left';
    }
  }

  _drawGrid(ctx, cw, ch) {
    // Draw a subtle 1-unit grid
    const { minX, maxX, minY, maxY } = this._bounds;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = this._pickGridStep(maxX - minX);
    const x0 = Math.ceil(minX / step) * step;
    for (let x = x0; x <= maxX; x += step) {
      const [cx] = this._m2c(x, minY);
      ctx.moveTo(cx, 0); ctx.lineTo(cx, ch);
    }
    const y0 = Math.ceil(minY / step) * step;
    for (let y = y0; y <= maxY; y += step) {
      const [, cy] = this._m2c(minX, y);
      ctx.moveTo(0, cy); ctx.lineTo(cw, cy);
    }
    ctx.stroke();

    // Axes
    if (minX <= 0 && maxX >= 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const [axX] = this._m2c(0, 0);
      ctx.moveTo(axX, 0); ctx.lineTo(axX, ch);
      ctx.stroke();
    }
    if (minY <= 0 && maxY >= 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const [, axY] = this._m2c(0, 0);
      ctx.moveTo(0, axY); ctx.lineTo(cw, axY);
      ctx.stroke();
    }
  }

  _pickGridStep(range) {
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100];
    for (const c of candidates) if (range / c < 30) return c;
    return 100;
  }

  _drawPoly(ctx, pts, fill, stroke, selected) {
    if (pts.length < 2) return;
    ctx.beginPath();
    const [fx, fy] = this._m2c(...pts[0]);
    ctx.moveTo(fx, fy);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = this._m2c(...pts[i]);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();
  }

  _drawLabel(ctx, pts, text, color) {
    if (!pts.length) return;
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;
    const [px, py] = this._m2c(cx, cy);
    const fs = Math.min(13, Math.max(8, this._zoom * 11));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(text, px + 1, py + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, px, py);
    ctx.textAlign = 'left';
  }

  _drawInProgress(ctx) {
    const cfg = REGION_CONFIG[this._drawType];
    const pts = this._drawPts;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = cfg.stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const [fx, fy] = this._m2c(...pts[0]);
    ctx.moveTo(fx, fy);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = this._m2c(...pts[i]);
      ctx.lineTo(px, py);
    }
    if (this._mouseMap) {
      const [mx, my] = this._m2c(...this._mouseMap);
      ctx.lineTo(mx, my);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Closing ring
    if (pts.length >= 3) {
      const [fpx, fpy] = this._m2c(...pts[0]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(fpx, fpy, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Vertex dots
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = this._m2c(...pts[i]);
      ctx.fillStyle = i === 0 ? '#fff' : cfg.stroke;
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Point counter
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px sans-serif';
    if (pts.length > 0) {
      const [lx, ly] = this._m2c(...pts[pts.length - 1]);
      ctx.fillText(`${pts.length} pts`, lx + 8, ly - 6);
    }
  }

  _drawHandles(ctx, pts) {
    for (const p of pts) {
      const [px, py] = this._m2c(...p);
      ctx.fillStyle = 'white';
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  _drawInProgressCircle(ctx) {
    const cfg = REGION_CONFIG[this._drawType];
    const [acx, acy] = this._drawAnchor;
    const [emx, emy] = this._mouseMap;
    const rMap    = Math.sqrt((emx - acx) ** 2 + (emy - acy) ** 2);
    const { scale } = this._getViewTransform();
    const rCanvas = Math.max(rMap * scale * this._zoom, 1);
    const [pcx, pcy] = this._m2c(acx, acy);
    const [pex, pey] = this._m2c(emx, emy);

    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(pcx, pcy, rCanvas, 0, Math.PI * 2);
    ctx.fillStyle = cfg.fill;
    ctx.fill();
    ctx.strokeStyle = cfg.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Center dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(pcx, pcy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Radius guide line
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pcx, pcy);
    ctx.lineTo(pex, pey);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '11px sans-serif';
    ctx.fillText(`r: ${rMap.toFixed(3)}`, pex + 8, pey - 6);
  }

  _drawInProgressEllipse(ctx) {
    const cfg = REGION_CONFIG[this._drawType];
    const [x1, y1] = this._drawAnchor;
    const [x2, y2] = this._mouseMap;
    const ecxM  = (x1 + x2) / 2;
    const ecyM  = (y1 + y2) / 2;
    const rxMap = Math.abs(x2 - x1) / 2;
    const ryMap = Math.abs(y2 - y1) / 2;
    const { scale } = this._getViewTransform();
    const rxC = Math.max(rxMap * scale * this._zoom, 1);
    const ryC = Math.max(ryMap * scale * this._zoom, 1);
    const [pCx, pCy] = this._m2c(ecxM, ecyM);
    const [p1x, p1y] = this._m2c(x1, y1);
    const [p2x, p2y] = this._m2c(x2, y2);

    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.ellipse(pCx, pCy, rxC, ryC, 0, 0, Math.PI * 2);
    ctx.fillStyle = cfg.fill;
    ctx.fill();
    ctx.strokeStyle = cfg.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Center dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(pCx, pCy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Bounding box guide
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(
      Math.min(p1x, p2x), Math.min(p1y, p2y),
      Math.abs(p2x - p1x), Math.abs(p2y - p1y)
    );
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '11px sans-serif';
    ctx.fillText(
      `${(rxMap * 2).toFixed(3)} × ${(ryMap * 2).toFixed(3)}`,
      Math.max(p1x, p2x) + 6,
      Math.max(p1y, p2y) - 6
    );
  }

  // ── Hit testing ───────────────────────────────────────────────────────────────
  _canvasPos(ev) {
    const r = this._canvas.getBoundingClientRect();
    return [
      (ev.clientX - r.left) * (this._canvas.width  / r.width),
      (ev.clientY - r.top)  * (this._canvas.height / r.height),
    ];
  }

  _hitRegion(cx, cy) {
    for (const t of HIT_ORDER) {
      if (!this._regions[t]) continue;
      for (let i = this._regions[t].length - 1; i >= 0; i--) {
        const r = this._regions[t][i];
        if (this._pip(cx, cy, r._parsedPoints)) return { type: t, id: r.id };
      }
    }
    return null;
  }

  _hitVertex(cx, cy, region) {
    const rad = 8;
    for (let i = 0; i < region._parsedPoints.length; i++) {
      const [px, py] = this._m2c(...region._parsedPoints[i]);
      if ((cx - px) ** 2 + (cy - py) ** 2 <= rad * rad) return i;
    }
    return -1;
  }

  // point-in-polygon (ray casting, canvas space)
  _pip(cx, cy, pts) {
    let inside = false;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = this._m2c(...pts[i]);
      const [xj, yj] = this._m2c(...pts[j]);
      const int_ = (yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi;
      if (int_) inside = !inside;
    }
    return inside;
  }

  _selRegion()       { return this._getRegion(this._selType, this._selId); }
  _getRegion(t, id)  { return (this._regions[t] || []).find(r => r.id === id) || null; }

  // ── Mouse events ──────────────────────────────────────────────────────────────
  _onDown(ev) {
    if (ev.button !== 0) return;
    const [cx, cy] = this._canvasPos(ev);

    // ── Merge mode ──
    if (this._mode === 'merge') {
      const hit = this._hitRegion(cx, cy);
      if (!hit || hit.type !== 'region_work') {
        this._status('⚠️ Merge mode: select work zones only');
        return;
      }

      const id = hit.id;
      if (this._mergeIds.includes(id)) {
        this._mergeIds = this._mergeIds.filter(mid => mid !== id);
      } else if (this._mergeIds.length < 2) {
        this._mergeIds.push(id);
      } else {
        this._mergeIds = [this._mergeIds[1], id];
      }

      this._selType = 'region_work';
      this._selId = id;

      if (this._mergeIds.length === 2) {
        const [idA, idB] = this._mergeIds;
        const a = this._getRegion('region_work', idA);
        const b = this._getRegion('region_work', idB);
        if (!a || !b || !this._areWorkRegionsAdjacent(a, b)) {
          this._mergeIds = [id];
          this._status('⚠️ Selected work zones are not adjacent. Pick neighboring zones.');
        } else {
          this._status(`🔗 Merge ready for work zones ${idA} and ${idB}. Submit map to send merge request.`);
        }
      } else {
        this._status('🔗 Merge mode: select one more adjacent work zone');
      }

      this._renderSidebar();
      this._renderProps();
      this._updateWorkflowStatus();
      this._redraw();
      return;
    }

    // ── Split mode ──
    if (this._mode === 'split') {
      if (this._splitPending) {
        this._status('⚠️ Split is pending. Submit map or reset before making changes.');
        return;
      }
      const hit = this._hitRegion(cx, cy);
      if (!this._splitRegionId) {
        // Phase 1: select the zone to split
        if (!hit || hit.type !== 'region_work') {
          this._status('⚠️ Split mode: click a work zone to select it for splitting');
          return;
        }
        this._splitRegionId = hit.id;
        this._splitLinePts  = [];
        this._selType = 'region_work';
        this._selId   = hit.id;
        this._status(`✂ Work zone selected. Click once to set start point, then once more to set end and finalize.`);
        this._renderSidebar();
        this._renderProps();
        this._updateWorkflowStatus();
        this._redraw();
      } else {
        // Phase 2: add line points (max 2 — second point auto-finalizes)
        this._splitLinePts.push(this._c2m(cx, cy));
        if (this._splitLinePts.length === 2) {
          this._finishSplit();
        } else {
          this._status('✂ Start point set. Click end point to finalize split.');
          this._updateWorkflowStatus();
          this._updateActionButtons();
          this._redraw();
        }
      }
      return;
    }

    // ── Draw mode ──
    if (this._mode === 'draw') {
      if (this._drawShape === 'circle' || this._drawShape === 'ellipse') {
        const mpos = this._c2m(cx, cy);
        this._drawAnchor = mpos;
        this._mouseMap   = mpos;
        this._redraw();
        return;
      }
      // Polygon: close if within snap distance of first point
      if (this._drawPts.length >= 3) {
        const [fpx, fpy] = this._m2c(...this._drawPts[0]);
        if ((cx - fpx) ** 2 + (cy - fpy) ** 2 < 100) { this._finishDraw(); return; }
      }
      if (!this._markEdited()) return;
      this._drawPts.push(this._c2m(cx, cy));
      this._redraw();
      return;
    }

    // ── Delete mode ──
    if (this._mode === 'delete') {
      const hit = this._hitRegion(cx, cy);
      if (hit && DELETABLE.includes(hit.type)) this._deleteRegion(hit.type, hit.id);
      return;
    }

    // ── Select mode ──
    const selR = this._selRegion();

    // Vertex drag
    if (selR && MODIFIABLE.includes(this._selType)) {
      const vi = this._hitVertex(cx, cy, selR);
      if (vi >= 0) {
        this._drag = { type: 'vertex', vi, orig: selR._parsedPoints.map(p => [...p]) };
        return;
      }
      // Region drag
      if (this._pip(cx, cy, selR._parsedPoints)) {
        const mp = this._c2m(cx, cy);
        this._drag = { type: 'move', smx: mp[0], smy: mp[1], orig: selR._parsedPoints.map(p => [...p]) };
        return;
      }
    }

    // Hit test for new selection
    const hit = this._hitRegion(cx, cy);
    if (hit) {
      this._selType = hit.type;
      this._selId   = hit.id;
      this._renderSidebar();
      this._renderProps();
      this._redraw();
      if (MODIFIABLE.includes(hit.type)) {
        const mp = this._c2m(cx, cy);
        const r2 = this._getRegion(hit.type, hit.id);
        if (r2) this._drag = { type: 'move', smx: mp[0], smy: mp[1], orig: r2._parsedPoints.map(p => [...p]) };
      }
    } else {
      // Pan
      this._selType = null; this._selId = null;
      this._drag = { type: 'pan', sx: cx, sy: cy, spx: this._panX, spy: this._panY };
      this._renderSidebar();
      this._renderProps();
      this._redraw();
    }
  }

  _onMove(ev) {
    const [cx, cy] = this._canvasPos(ev);
    this._mouseMap = this._c2m(cx, cy);

    if (!this._drag) {
      if (this._mode === 'draw') this._redraw();
      else this._redraw(); // refresh coord overlay
      return;
    }

    switch (this._drag.type) {
      case 'pan': {
        this._panX = this._drag.spx + (cx - this._drag.sx);
        this._panY = this._drag.spy + (cy - this._drag.sy);
        this._redraw();
        break;
      }
      case 'vertex': {
        const r = this._selRegion();
        if (r) {
          if (!this._markEdited()) return;
          r._parsedPoints[this._drag.vi] = this._c2m(cx, cy);
          this._syncRegionDerivedFields(this._selType, r);
          this._renderProps();
          this._redraw();
        }
        break;
      }
      case 'move': {
        const r = this._selRegion();
        if (r) {
          if (!this._markEdited()) return;
          const [mx, my] = this._c2m(cx, cy);
          const dx = mx - this._drag.smx, dy = my - this._drag.smy;
          r._parsedPoints = this._drag.orig.map(([x, y]) => [x + dx, y + dy]);
          this._redraw();
        }
        break;
      }
    }
  }

  _onUp() {
    if (this._drag) { this._drag = null; return; }
    if (this._mode === 'draw' && this._drawAnchor && this._mouseMap) {
      if (this._drawShape === 'circle')       this._finishCircleDraw();
      else if (this._drawShape === 'ellipse') this._finishEllipseDraw();
      this._drawAnchor = null;
    }
  }

  _onDbl(ev) {
    if (this._mode === 'draw') {
      // The mousedown that fired before dblclick already added a point — remove it
      if (this._drawPts.length > 0) this._drawPts.pop();
      if (this._drawPts.length >= 3) this._finishDraw();
    }
  }

  _onWheel(ev) {
    ev.preventDefault();
    const [cx, cy] = this._canvasPos(ev);
    const factor = ev.deltaY > 0 ? 0.85 : 1 / 0.85;
    const nz = Math.max(0.05, Math.min(200, this._zoom * factor));
    const f = nz / this._zoom;
    this._panX = cx + (this._panX - cx) * f;
    this._panY = cy + (this._panY - cy) * f;
    this._zoom = nz;
    this._redraw();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  _onKeyDown(ev) {
    // Skip if typing in an input field (even inside shadow DOM)
    const target = ev.composedPath()[0];
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    // Shift+R: Reset and reload
    if (ev.shiftKey && (ev.key === 'R' || ev.key === 'r')) {
      ev.preventDefault();
      this._resetAndReload();
      return;
    }

    switch (ev.key) {
      case 'Escape':
        this._cancelDraw();
        break;
      case 'Enter':
        if (this._mode === 'draw') this._finishDraw();
        else if (this._mode === 'split') this._finishSplit();
        break;
      case 'z': case 'Z':
        if (this._mode === 'draw') {
          this._undoPoint();
        } else if (this._mode === 'split') {
          this._undoSplitPoint();
        } else if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          this._undoDelete();
        }
        break;
      case 's': case 'S':
        this._setMode('select');
        break;
      case 'd': case 'D':
        this._setMode('delete');
        break;
      case 'w': case 'W':
        this._setMode('draw');
        break;
      case 'f': case 'F':
        this._resetView(); this._redraw();
        break;
      case 'Delete': case 'Backspace':
        if (this._selId && DELETABLE.includes(this._selType)) {
          ev.preventDefault();
          this._deleteRegion(this._selType, this._selId);
        }
        break;
    }
  }

  // ── Mode management ───────────────────────────────────────────────────────────
  _setMode(mode) {
    if (mode === 'merge') {
      if (this._hasLocalEdits) {
        this._status('⚠️ Merge requires a clean map. Submit/reset current edits first.');
        return;
      }
      if (this._splitPending) {
        this._status('⚠️ Split is pending. Submit map or reset before switching to Merge.');
        return;
      }
    } else if (mode === 'split') {
      if (this._hasLocalEdits) {
        this._status('⚠️ Split requires a clean map. Submit/reset current edits first.');
        return;
      }
      if (this._mergeIds.length === 2) {
        this._status('⚠️ Merge is pending. Submit map or reset before switching to Split.');
        return;
      }
    } else if (this._mergeIds.length === 2 && (mode === 'draw' || mode === 'delete')) {
      this._status('⚠️ Merge is pending. Submit map or reset before making other changes.');
      return;
    } else if (this._splitPending && (mode === 'draw' || mode === 'delete')) {
      this._status('⚠️ Split is pending. Submit map or reset before making other changes.');
      return;
    }

    const prev = this._mode;
    this._mode = mode;
    if (prev === 'draw' && mode !== 'draw') { this._drawPts = []; this._drawAnchor = null; }
    // Leaving split mode without a finalized line clears the in-progress drawing
    if (prev === 'split' && mode !== 'split' && !this._splitPending) {
      this._splitRegionId = null;
      this._splitLinePts  = [];
    }
    ['select', 'merge', 'split', 'draw', 'delete'].forEach(m => {
      const b = this.shadowRoot.getElementById(`mode-${m}`);
      if (b) b.classList.toggle('active', m === mode);
    });
    const cursors = { select: 'default', merge: 'copy', split: 'crosshair', draw: 'crosshair', delete: 'not-allowed' };
    this._ca.style.cursor = cursors[mode] || 'default';
    this._hint.classList.toggle('on', mode === 'draw');
    if (mode === 'draw') this._updateDrawHint();
    this._updateActionButtons();
    this._updateWorkflowStatus();
    this._redraw();
  }

  _updateActionButtons() {
    const draw        = this._mode === 'draw';
    const splitMode   = this._mode === 'split';
    const polyDraw    = draw && this._drawShape === 'polygon';
    const mergePending = this._mergeIds.length === 2;
    const splitLinePts = this._splitLinePts.length;
    const anyPending  = mergePending || this._splitPending;
    const undoEnabled = polyDraw || this._mode === 'delete'
      || (splitMode && (this._splitLinePts.length > 0 || this._splitPending));

    const undoBtn   = this.shadowRoot.getElementById('btn-undo');
    const doneBtn   = this.shadowRoot.getElementById('btn-finish');
    const cancelBtn = this.shadowRoot.getElementById('btn-cancel');
    const drawBtn   = this.shadowRoot.getElementById('mode-draw');
    const deleteBtn = this.shadowRoot.getElementById('mode-delete');
    const mergeBtn  = this.shadowRoot.getElementById('mode-merge');
    const splitBtn  = this.shadowRoot.getElementById('mode-split');

    if (undoBtn)   undoBtn.disabled   = !undoEnabled;
    if (doneBtn)   doneBtn.disabled   = !polyDraw;
    if (cancelBtn) cancelBtn.disabled = !(draw || splitMode);
    if (drawBtn)   drawBtn.disabled   = anyPending;
    if (deleteBtn) deleteBtn.disabled = anyPending;
    if (mergeBtn)  mergeBtn.disabled  = this._hasLocalEdits || this._splitPending;
    if (splitBtn)  splitBtn.disabled  = this._hasLocalEdits || mergePending;
    this._updateWorkflowStatus();
  }

  _updateWorkflowStatus() {
    if (!this._workflowStatus) return;

    this._workflowStatus.classList.remove('clean', 'edited', 'merge');

    if (this._splitPending) {
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = `State: Split pending (zone ${this._splitRegionId}, ${this._splitLinePts.length} pts — submit to send)`;
      return;
    }

    if (this._mode === 'split' && this._splitLinePts.length > 0) {
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = `State: Split drawing (zone ${this._splitRegionId}, ${this._splitLinePts.length} pts)`;
      return;
    }

    if (this._mode === 'split' && this._splitRegionId) {
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = `State: Split select zone ${this._splitRegionId} — draw line across it`;
      return;
    }

    if (this._mode === 'split') {
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = 'State: Split — click a work zone to start';
      return;
    }

    if (this._mergeIds.length === 2) {
      const [a, b] = this._mergeIds;
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = `State: Merge pending (${a}, ${b})`;
      return;
    }

    if (this._mode === 'merge' && this._mergeIds.length === 1) {
      this._workflowStatus.classList.add('merge');
      this._workflowStatus.textContent = `State: Merge select (${this._mergeIds[0]} + ?)`;
      return;
    }

    if (this._hasLocalEdits) {
      this._workflowStatus.classList.add('edited');
      this._workflowStatus.textContent = 'State: Edited (submit/reset before merge or split)';
      return;
    }

    this._workflowStatus.classList.add('clean');
    this._workflowStatus.textContent = 'State: Clean';
  }

  _setDrawShape(shape) {
    this._drawShape  = shape;
    this._drawPts    = [];
    this._drawAnchor = null;
    ['polygon', 'circle', 'ellipse'].forEach(s => {
      const b = this.shadowRoot.getElementById(`shape-${s}`);
      if (b) b.classList.toggle('active', s === shape);
    });
    this._updateDrawHint();
    this._updateActionButtons();
    this._redraw();
  }

  _updateDrawHint() {
    if (!this._hint) return;
    const hints = {
      polygon: 'Click to add points\u00a0\u00b7\u00a0Click first point or Enter to finish\u00a0\u00b7\u00a0Right-click / Esc to cancel\u00a0\u00b7\u00a0Z to undo',
      circle:  'Click and drag from center outward to set radius\u00a0\u00b7\u00a0Release to place\u00a0\u00b7\u00a0Esc to cancel',
      ellipse: 'Click and drag to define bounding box\u00a0\u00b7\u00a0Release to place\u00a0\u00b7\u00a0Esc to cancel',
    };
    this._hint.textContent = hints[this._drawShape] || hints.polygon;
  }

  _undoPoint() {
    if (this._drawPts.length > 0) { this._drawPts.pop(); this._redraw(); }
  }

  _finishSplit() {
    if (this._splitPending) { this._status('⚠️ Split already finalized — submit or reset'); return; }
    if (!this._splitRegionId) { this._status('⚠️ No work zone selected for split'); return; }
    if (this._splitLinePts.length < 2) { this._status('⚠️ Need at least 2 points for the split line'); return; }
    this._splitPending = true;
    this._updateActionButtons();
    this._status(`✂ Split ready: zone ${this._splitRegionId} with ${this._splitLinePts.length}-point line. Submit map to send.`);
  }

  _undoSplitPoint() {
    if (this._splitPending) {
      // Un-finalize: go back to drawing
      this._splitPending = false;
      this._updateActionButtons();
      this._status('↩ Split un-finalized — keep adding points or Done when ready');
      return;
    }
    if (this._splitLinePts.length > 0) {
      this._splitLinePts.pop();
      this._updateActionButtons();
      this._redraw();
    } else if (this._splitRegionId) {
      this._splitRegionId = null;
      this._updateWorkflowStatus();
      this._redraw();
      this._status('↩ Zone deselected — click a work zone to start split');
    }
  }

  _finishDraw() {
    if (this._drawPts.length < 3) { this._status('⚠️ Need at least 3 points'); return; }
    if (!DRAWABLE.includes(this._drawType)) {
      this._status('⚠️ This region type is delete-only');
      this._drawPts = [];
      this._redraw();
      return;
    }
    const pts = [...this._drawPts];
    // Close polygon
    if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) {
      pts.push([...pts[0]]);
    }
    const r = this._makeRegion(this._drawType, pts);
    if (!this._markEdited()) return;
    this._regions[this._drawType].push(r);
    this._drawPts = [];
    this._selType = this._drawType;
    this._selId   = r.id;
    this._renderSidebar();
    this._renderProps();
    this._redraw();
    this._status(`✅ Added ${REGION_CONFIG[this._drawType].label} (${pts.length} pts)`);
  }

  _cancelDraw() {
    if (this._mode === 'split') {
      if (this._splitLinePts.length > 0 || this._splitRegionId) {
        this._splitRegionId = null;
        this._splitLinePts  = [];
        this._splitPending  = false;
        this._redraw();
        this._updateActionButtons();
        this._status('Split cancelled');
      }
      return;
    }
    if (this._drawPts.length > 0 || this._drawAnchor) {
      this._drawPts    = [];
      this._drawAnchor = null;
      this._redraw();
      this._status('Drawing cancelled');
    }
  }

  _finishCircleDraw() {
    const [acx, acy] = this._drawAnchor;
    const [emx, emy] = this._mouseMap;
    const r = Math.sqrt((emx - acx) ** 2 + (emy - acy) ** 2);
    if (r < 1e-4) { this._status('⚠️ Circle too small — drag further from center'); return; }
    const N = 64;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      pts.push([acx + r * Math.cos(a), acy + r * Math.sin(a)]);
    }
    pts.push([...pts[0]]);
    this._commitDrawnShape(pts, 'circle');
  }

  _finishEllipseDraw() {
    const [x1, y1] = this._drawAnchor;
    const [x2, y2] = this._mouseMap;
    const ecx = (x1 + x2) / 2;
    const ecy = (y1 + y2) / 2;
    const rx  = Math.abs(x2 - x1) / 2;
    const ry  = Math.abs(y2 - y1) / 2;
    if (rx < 1e-4 || ry < 1e-4) { this._status('⚠️ Ellipse too small — drag further'); return; }
    const N = 64;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      pts.push([ecx + rx * Math.cos(a), ecy + ry * Math.sin(a)]);
    }
    pts.push([...pts[0]]);
    this._commitDrawnShape(pts, 'ellipse');
  }

  _commitDrawnShape(pts, shapeLabel) {
    if (!DRAWABLE.includes(this._drawType)) {
      this._status('⚠️ This region type is delete-only');
      return;
    }
    const r = this._makeRegion(this._drawType, pts);
    if (!this._markEdited()) return;
    this._regions[this._drawType].push(r);
    this._selType = this._drawType;
    this._selId   = r.id;
    this._renderSidebar();
    this._renderProps();
    this._redraw();
    this._status(`✅ Added ${shapeLabel} as ${REGION_CONFIG[this._drawType].label} (${pts.length - 1} pts)`);
  }

  _makeRegion(type, points) {
    this._idOffset++;
    const id = Date.now() + this._idOffset;
    const cfg = REGION_CONFIG[type];
    const base = {
      center_point: { x: 0.0, y: 0.0 },
      effective_area: cfg.effective_area,
      id,
      points: stringifyPoints(points),
      points_num: points.length,
      _parsedPoints: points,
    };
    switch (type) {
      case 'region_work': {
        const area = this._polygonArea(points);
        return {
          ...base,
          name: 'New Zone',
          area_size:            area,
          time_balanced:        Math.round(area * (5 / 8)    * 1000) / 1000,
          time_fine_tune:       Math.round(area * (5 / 7)    * 1000) / 1000,
          time_high_efficiency: Math.round(area * (1 / 2.7)  * 1000) / 1000,
        };
      }
      case 'region_channel':
        return { ...base, split_line: true, track_points: [] };
      case 'region_forbidden':
        return { ...base, name: '', type: 'normal' };
      case 'region_obstacle':
        return { ...base, is_learn: false };
      case 'region_placed_blank':
        return { ...base, name: '' };
      default:
        return base;
    }
  }

  _syncRegionDerivedFields(type, region) {
    if (!region || !Array.isArray(region._parsedPoints)) return;
    if (type === 'region_work') {
      const area = this._polygonArea(region._parsedPoints);
      region.area_size             = area;
      region.time_balanced         = Math.round(area * (5 / 8)    * 1000) / 1000;
      region.time_fine_tune        = Math.round(area * (5 / 7)    * 1000) / 1000;
      region.time_high_efficiency  = Math.round(area * (1 / 2.7)  * 1000) / 1000;
    }
  }

  _polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      area += x1 * y2 - x2 * y1;
    }
    return Math.round((Math.abs(area) / 2) * 100) / 100;
  }

  _deleteRegion(type, id) {
    const list = this._regions[type] || [];
    const idx  = list.findIndex(r => r.id === id);
    if (idx === -1) return;
    if (!this._markEdited()) return;
    const [removed] = list.splice(idx, 1);
    if (this._selId === id && this._selType === type) { this._selType = null; this._selId = null; }
    this._deletedStack.push({ type, region: removed, idx });
    if (this._deletedStack.length > 20) this._deletedStack.shift();
    this._renderSidebar();
    this._renderProps();
    this._redraw();
    const label = REGION_CONFIG[type]?.label || type;
    this._statusUndo(`🗑 Deleted "${removed.name || label}"`);
  }

  _undoDelete() {
    if (!this._deletedStack.length) { this._status('Nothing to undo'); return; }
    const { type, region, idx } = this._deletedStack.pop();
    this._markEdited();
    const list = this._regions[type] || [];
    list.splice(Math.min(idx, list.length), 0, region);
    this._selType = type;
    this._selId   = region.id;
    this._renderSidebar();
    this._renderProps();
    this._redraw();
    const label = REGION_CONFIG[type]?.label || type;
    this._status(`↩ Restored "${region.name || label}"`);
  }

  _statusUndo(msg) {
    if (!this._stbar) return;
    this._stbar.innerHTML =
      `${escHtml(msg)}&nbsp;&nbsp;<a href="#" id="undo-link" style="color:var(--primary-color,#03A9F4);text-decoration:none;font-weight:600">↩ Undo</a>`;
    const link = this._stbar.querySelector('#undo-link');
    if (link) link.addEventListener('click', e => { e.preventDefault(); this._undoDelete(); });
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────────
  _renderSidebar() {
    if (!this._mapData) {
      this._sb.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:12px;text-align:center;padding:20px">Import a map file to begin</div>';
      return;
    }
    let html = '';
    for (const t of DELETABLE) {
      const cfg = REGION_CONFIG[t];
      const list = this._regions[t] || [];
      html += `<div class="grp-hdr">
        <span class="dot" style="background:${cfg.stroke}"></span>
        ${cfg.icon} ${cfg.label}
        <span class="cnt">${list.length}</span>
        ${DRAWABLE.includes(t) ? `<button class="addbtn" data-type="${t}" title="Draw new ${cfg.label}">＋</button>` : ''}
      </div>`;
      for (const r of list) {
        const sel  = r.id === this._selId && t === this._selType;
        const mergeSel = t === 'region_work' && this._mergeIds.includes(r.id);
        const name = r.name || `…${String(r.id).slice(-7)}`;
        const canRename = t === 'region_work';
        html += `<div class="ri${sel || mergeSel ? ' sel' : ''}" data-type="${t}" data-id="${r.id}">
          <span class="rn" ${canRename ? 'title="Double-click to rename"' : ''}>${escHtml(name)}</span>
          <button class="rdel" data-type="${t}" data-id="${r.id}" title="Delete">✕</button>
        </div>`;
      }
    }
    // Read-only charger channel
    const ccfg  = REGION_CONFIG.region_charger_channel;
    const clist = this._regions.region_charger_channel || [];
    if (clist.length) {
      html += `<div class="grp-hdr">
        <span class="dot" style="background:${ccfg.stroke}"></span>
        ${ccfg.icon} ${ccfg.label} (read-only)
        <span class="cnt">${clist.length}</span>
      </div>`;
      for (const r of clist) {
        const sel = r.id === this._selId && this._selType === 'region_charger_channel';
        html += `<div class="ri${sel ? ' sel' : ''}" data-type="region_charger_channel" data-id="${r.id}">
          <span class="rn">…${String(r.id).slice(-7)}</span>
        </div>`;
      }
    }

    this._sb.innerHTML = html;

    this._sb.querySelectorAll('.ri').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev.target.classList.contains('rdel')) return;
        if (ev.target.classList.contains('rname')) return;
        this._selType = el.dataset.type;
        this._selId   = Number(el.dataset.id);
        this._renderSidebar();
        this._renderProps();
        this._redraw();
        this._centerOn(this._selType, this._selId);
      });

      const nameEl = el.querySelector('.rn');
      if (nameEl && el.dataset.type === 'region_work') {
        nameEl.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          const id = Number(el.dataset.id);
          const region = this._getRegion('region_work', id);
          if (!region) return;

          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'rname';
          input.value = region.name || '';

          const commit = () => {
            const next = input.value.trim();
            if (next !== (region.name || '') && !this._markEdited()) {
              this._renderSidebar();
              return;
            }
            region.name = next;
            this._renderSidebar();
            if (this._selType === 'region_work' && this._selId === id) this._renderProps();
            this._redraw();
          };

          input.addEventListener('click', e2 => e2.stopPropagation());
          input.addEventListener('keydown', e2 => {
            if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
            if (e2.key === 'Escape') { e2.preventDefault(); this._renderSidebar(); }
          });
          input.addEventListener('blur', () => commit(), { once: true });

          nameEl.replaceWith(input);
          input.focus();
          input.select();
        });
      }
    });
    this._sb.querySelectorAll('.rdel').forEach(el => {
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        this._deleteRegion(el.dataset.type, Number(el.dataset.id));
      });
    });
    this._sb.querySelectorAll('.addbtn').forEach(el => {
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        this._drawType = el.dataset.type;
        this.shadowRoot.getElementById('draw-type').value = el.dataset.type;
        this._setMode('draw');
      });
    });
  }

  // ── Properties panel ─────────────────────────────────────────────────────────
  _renderProps() {
    const panel = this._props;
    const r = this._selRegion();
    if (!r || (!MODIFIABLE.includes(this._selType) && this._selType !== 'region_work')) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    const t   = this._selType;
    const cfg = REGION_CONFIG[t];
    let html  = `<h4>${cfg.icon} ${cfg.label}</h4>`;

    if (t === 'region_work') {
      html += `<label>Name</label><input type="text" id="p-name" value="${escHtml(r.name || '')}">`;
    }
    if (t === 'region_work') {
      html += `<label>Area (m²)</label><input type="number" id="p-area" value="${r.area_size ?? 0}" step="0.01" readonly>`;
      html += `<label>Time — Balanced (min)</label><input type="number" id="p-tbal" value="${r.time_balanced ?? 0}" step="0.001" readonly>`;
      html += `<label>Time — Fine Tune (min)</label><input type="number" id="p-tfine" value="${r.time_fine_tune ?? 0}" step="0.001" readonly>`;
      html += `<label>Time — High Efficiency (min)</label><input type="number" id="p-theff" value="${r.time_high_efficiency ?? 0}" step="0.001" readonly>`;
    }
    html += `<div class="pts-info">Vertices: ${r._parsedPoints.length}</div>`;
    panel.innerHTML = html;

    const ni = panel.querySelector('#p-name');
    if (ni) ni.addEventListener('input', e => {
      if (r.name !== e.target.value && !this._markEdited()) {
        e.target.value = r.name || '';
        return;
      }
      r.name = e.target.value;
      this._renderSidebar();
      this._redraw();
    });
  }

  _centerOn(type, id) {
    const r = this._getRegion(type, id);
    if (!r || !r._parsedPoints.length) return;
    const pts = r._parsedPoints;
    const mx  = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my  = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const cw  = this._canvas.width, ch = this._canvas.height;
    const [px, py] = this._m2c(mx, my);
    this._panX += cw / 2 - px;
    this._panY += ch / 2 - py;
    this._redraw();
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  _buildMapPayload() {
    if (!this._mapData) return null;
    const now = Date.now();
    const out = JSON.parse(JSON.stringify(this._mapData));

    for (const t of EDITABLE) {
      out[t] = (this._regions[t] || []).map((r, i) => {
        const copy = { ...r };
        delete copy._parsedPoints;
        copy.points     = stringifyPoints(r._parsedPoints);
        copy.points_num = r._parsedPoints.length;
        return copy;
      });
    }
    // Keep charger channel unchanged
    out.region_charger_channel = (this._regions.region_charger_channel || []).map(r => {
      const copy = { ...r };
      delete copy._parsedPoints;
      return copy;
    });
    out.update_time = now;
    if (this._mergeIds.length === 2) {
      out.merge_region_ids = [...this._mergeIds];
      out.merge_regionsid = [...this._mergeIds];
    } else {
      delete out.merge_region_ids;
      delete out.merge_regionsid;
    }
    if (this._splitPending && this._splitRegionId && this._splitLinePts.length >= 2) {
      out.split_region_id  = this._splitRegionId;
      out.split_regionid   = this._splitRegionId;
      out.split_line       = this._splitLinePts.map(([x, y]) => [
        Math.round(x * 1000) / 1000,
        Math.round(y * 1000) / 1000,
      ]);
    } else {
      delete out.split_region_id;
      delete out.split_regionid;
      delete out.split_line;
    }
    return out;
  }

  async _submitMap() {
    if (!this._hass) { this._status('⚠️ Home Assistant connection not available'); return; }
    if (!this._mapData) { this._status('⚠️ No map loaded'); return; }
    if (!this._config?.entity) {
      this._status('⚠️ No entity configured. Pick a map image entity in card editor first.');
      return;
    }

    const ok = await this._confirmAction(
      'Submit map',
      `Submit current map?`
    );
    if (!ok) {
      this._status('Submit cancelled');
      return;
    }

    const out = this._buildMapPayload();
    if (!out) { this._status('⚠️ No map loaded'); return; }

    if (this._mergeIds.length === 2) {
      const [idA, idB] = this._mergeIds;
      const a = this._getRegion('region_work', idA);
      const b = this._getRegion('region_work', idB);
      if (!a || !b || !this._areWorkRegionsAdjacent(a, b)) {
        this._status('⚠️ Merge zones are no longer valid/adjacent. Re-select merge zones.');
        return;
      }
      if (this._hasLocalEdits) {
        this._status('⚠️ Merge request must be submitted before making other edits.');
        return;
      }
    }

    if (this._splitPending) {
      if (!this._splitRegionId || this._splitLinePts.length < 2) {
        this._status('⚠️ Split data is invalid. Re-draw the split line.');
        return;
      }
      if (!this._getRegion('region_work', this._splitRegionId)) {
        this._status('⚠️ Split zone no longer exists. Re-select a zone.');
        return;
      }
    }

    // Keep editor map stable while backend persists and updates entity attributes.
    this._submittedMapSignature = JSON.stringify(out);
    this._ignoreEntityMapUntil = Date.now() + 6000;
    if (this._postSubmitRefreshTimer) clearTimeout(this._postSubmitRefreshTimer);
    this._postSubmitRefreshTimer = setTimeout(() => {
      this._postSubmitRefreshTimer = null;
      this._tryLoadFromEntity();
    }, 6500);

    try {
      await this._hass.callService(SERVICE_DOMAIN, SERVICE_SET_MAP, {
        entity_id: this._config.entity,
        map: out,
      });
      this._hasLocalEdits = false;
      this._mergeIds = [];
      this._splitRegionId = null;
      this._splitLinePts  = [];
      this._splitPending  = false;
      this._updateActionButtons();
      this._renderSidebar();
      this._status(`☁ Submitted map to ${SERVICE_DOMAIN}.${SERVICE_SET_MAP} (${this._config.entity})`);
      this._updateWorkflowStatus();
    } catch (err) {
      this._status(`❌ Submit failed: ${err?.message || err}`);
    }
  }

  _save() {
    const out = this._buildMapPayload();
    if (!out) { this._status('⚠️ No map loaded'); return; }

    const json = JSON.stringify(out, null, '\t');
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${(this._filename || 'map').replace(/\.json$/i, '')}_${out.update_time}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this._status(`💾 Saved as: ${a.download}`);
  }

  _resetAndReload() {
    // Clear all editing state
    this._mapData      = null;
    this._regions      = {};
    this._selType      = null;
    this._selId        = null;
    this._mode         = 'select';
    this._drawType     = 'region_obstacle';
    this._drawPts      = [];
    this._drawShape    = 'polygon';
    this._drawAnchor   = null;
    this._mouseMap     = null;
    this._zoom         = 1.0;
    this._panX         = 0;
    this._panY         = 0;
    this._bounds       = { minX: -20, maxX: 20, minY: -20, maxY: 20 };
    this._drag         = null;
    this._deletedStack = [];
    this._lastEntityKey = null;
    this._hasLocalEdits = false;
    this._mergeIds = [];
    this._splitRegionId = null;
    this._splitLinePts  = [];
    this._splitPending  = false;

    // Reset post-submit markers to allow immediate reload
    this._ignoreEntityMapUntil = 0;
    this._submittedMapSignature = null;
    if (this._postSubmitRefreshTimer) {
      clearTimeout(this._postSubmitRefreshTimer);
      this._postSubmitRefreshTimer = null;
    }

    // Clear UI
    this._redraw();
    this._renderSidebar();
    this._renderProps();
    // Sync shape buttons back to polygon
    ['polygon', 'circle', 'ellipse'].forEach(s => {
      const b = this.shadowRoot.getElementById(`shape-${s}`);
      if (b) b.classList.toggle('active', s === 'polygon');
    });
    this._updateActionButtons();
    this._updateWorkflowStatus();
    this._status('🔄 Reloading from entity...');

    // Force reload from entity attribute
    this._tryLoadFromEntity();
  }

  _getBackupContext(attributes) {
    const attrs = attributes || this._hass?.states?.[this._config?.entity || '']?.attributes || {};
    const backup = attrs.map_backup && typeof attrs.map_backup === 'object' ? attrs.map_backup : {};
    const rows = Array.isArray(backup.data) ? [...backup.data] : [];
    rows.sort((a, b) => {
      const ta = Number(a?.mapId || 0);
      const tb = Number(b?.mapId || 0);
      return tb - ta;
    });
    const backups = rows.slice(0, 5);
    const currentMapId = String(attrs.map_id ?? this._mapData?.update_time ?? '');
    return { backups, currentMapId };
  }

  _renderBackupPanel(attributes) {
    if (!this._backupSub || !this._backupGrid || !this._backupBtn) return;
    if (!this._hass || !this._config?.entity) {
      this._backupSub.textContent = 'Select an image entity to show map backups';
      this._backupGrid.innerHTML = '<div class="backup-empty">No backup data available.</div>';
      this._backupBtn.disabled = true;
      return;
    }

    const { backups, currentMapId } = this._getBackupContext(attributes);
    const sig = JSON.stringify({
      map_id: currentMapId,
      ids: backups.map(b => String(b.id ?? '') + ':' + String(b.mapId ?? '')),
      thumbs: backups.map(b => String(b.thumbnailUrl ?? '')),
    });
    if (sig === this._backupSig) return;
    this._backupSig = sig;

    const count = backups.length;
    this._backupSub.textContent = `Backups: ${count}/5${currentMapId ? ` · Current map id: ${currentMapId}` : ''}`;
    this._backupBtn.disabled = !currentMapId || count >= 5;

    if (!count) {
      this._backupGrid.innerHTML = '<div class="backup-empty">No backups yet. Use "Backup Current" to create one.</div>';
      return;
    }

    this._backupGrid.innerHTML = backups.map((b, i) => {
      const id = String(b.id ?? '');
      const mapId = String(b.mapId ?? b.updateTime ?? '');
      const isCurrent = currentMapId && mapId === currentMapId;
      const thumb = escHtml(b.thumbnailUrl || '');
      const name = escHtml(b.mapName || `Backup ${i + 1}`);
      const createTime = escHtml(b.createTime || '');
      const area = b.mapArea != null ? Number(b.mapArea).toFixed(2) : '';
      return `
        <div class="backup-item${isCurrent ? ' current' : ''}">
          <div class="backup-thumb-wrap">
            ${thumb ? `<img class="backup-thumb" loading="lazy" src="${thumb}" alt="${name}">` : '<div class="backup-thumb"></div>'}
            ${isCurrent ? '<div class="backup-badge">Current</div>' : ''}
          </div>
          <div class="backup-meta">
            <div><strong>${name}</strong></div>
            <div class="dim">Map ID: ${escHtml(mapId)}</div>
            <div class="dim">${createTime}${area ? ` · ${area} m²` : ''}</div>
          </div>
          <div class="backup-actions">
            <button class="btn" data-restore-mapid="${escHtml(mapId)}" ${isCurrent ? 'disabled' : ''}>Restore</button>
            <button class="btn del" data-delete-mapid="${escHtml(mapId)}" ${isCurrent ? 'disabled' : ''}>Delete</button>
          </div>
        </div>`;
    }).join('');

    this._backupGrid.querySelectorAll('[data-restore-mapid]').forEach(btn => {
      btn.addEventListener('click', () => this._restoreMap(btn.dataset.restoreMapid));
    });
    this._backupGrid.querySelectorAll('[data-delete-mapid]').forEach(btn => {
      btn.addEventListener('click', () => this._deleteBackup(btn.dataset.deleteMapid));
    });
  }

  async _backupCurrentMap() {
    if (!this._hass || !this._config?.entity) {
      this._status('⚠️ No entity configured');
      return;
    }
    const { backups, currentMapId } = this._getBackupContext();
    if (!currentMapId) {
      this._status('⚠️ Could not find current map_id in entity attributes');
      return;
    }
    if (backups.length >= 5) {
      this._status('⚠️ Maximum 5 backups reached. Restore or remove old backups first.');
      return;
    }

    const ok = await this._confirmAction('Backup map', `Create backup for map id ${currentMapId}?`);
    if (!ok) {
      this._status('Backup cancelled');
      return;
    }

    try {
      await this._hass.callService(SERVICE_DOMAIN, SERVICE_BACKUP_MAP, {
        entity_id: this._config.entity,
        mapid: String(currentMapId),
      });
      this._status(`🗂 Backup requested for map id ${currentMapId}`);
      setTimeout(() => this._tryLoadFromEntity(), 2500);
    } catch (err) {
      this._status(`❌ Backup failed: ${err?.message || err}`);
    }
  }

  async _restoreMap(mapId) {
    if (!this._hass || !this._config?.entity || !mapId) {
      this._status('⚠️ Missing restore data');
      return;
    }

    const ok = await this._confirmAction('Restore map', `Restore backup map id ${mapId}?`);
    if (!ok) {
      this._status('Restore cancelled');
      return;
    }

    try {
      await this._hass.callService(SERVICE_DOMAIN, SERVICE_RESTORE_MAP, {
        entity_id: this._config.entity,
        mapid: String(mapId),
      });
      this._status(`♻️ Restore requested for map id ${mapId}`);
      setTimeout(() => this._tryLoadFromEntity(), 3500);
    } catch (err) {
      this._status(`❌ Restore failed: ${err?.message || err}`);
    }
  }

  async _deleteBackup(mapId) {
    if (!this._hass || !this._config?.entity || !mapId) {
      this._status('⚠️ Missing delete data');
      return;
    }

    const ok = await this._confirmAction('Delete backup', `Delete backup map id ${mapId}?`);
    if (!ok) {
      this._status('Delete cancelled');
      return;
    }

    try {
      await this._hass.callService(SERVICE_DOMAIN, SERVICE_DELETE_BACKUP, {
        entity_id: this._config.entity,
        mapid: String(mapId),
      });
      this._status(`🗑 Deleted backup map id ${mapId}`);
      setTimeout(() => this._tryLoadFromEntity(), 2500);
    } catch (err) {
      this._status(`❌ Delete backup failed: ${err?.message || err}`);
    }
  }

  _confirmAction(title, message) {
    if (!this._confirmDlg || !this._confirmTitle || !this._confirmMsg) {
      return Promise.resolve(window.confirm(message));
    }

    this._confirmTitle.textContent = title;
    this._confirmMsg.textContent = message;
    this._confirmDlg.classList.add('open');
    this._confirmDlg.setAttribute('aria-hidden', 'false');

    return new Promise(resolve => {
      const close = result => {
        this._confirmDlg.classList.remove('open');
        this._confirmDlg.setAttribute('aria-hidden', 'true');
        this._confirmOk?.removeEventListener('click', onOk);
        this._confirmCancel?.removeEventListener('click', onCancel);
        this._confirmDlg?.removeEventListener('click', onBackdrop);
        resolve(result);
      };

      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onBackdrop = e => {
        if (e.target === this._confirmDlg) close(false);
      };

      this._confirmOk?.addEventListener('click', onOk);
      this._confirmCancel?.addEventListener('click', onCancel);
      this._confirmDlg?.addEventListener('click', onBackdrop);
    });
  }

  _status(msg) { if (this._stbar) this._stbar.textContent = msg; }

  _markEdited() {
    if (this._mergeIds.length === 2) {
      this._status('⚠️ Merge is pending. Submit map or reset before making other changes.');
      return false;
    }
    if (this._splitPending) {
      this._status('⚠️ Split is pending. Submit map or reset before making other changes.');
      return false;
    }
    this._hasLocalEdits = true;
    this._updateActionButtons();
    this._updateWorkflowStatus();
    return true;
  }

  _workPoints(region) {
    if (!region || !Array.isArray(region._parsedPoints)) return [];
    const pts = region._parsedPoints;
    if (pts.length > 2) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) return pts.slice(0, -1);
    }
    return pts;
  }

  _segments(points) {
    const segs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      segs.push([a, b]);
    }
    return segs;
  }

  _boundsOf(points) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
  }

  _boundsNear(a, b, tol) {
    return !(
      a.maxX < b.minX - tol ||
      b.maxX < a.minX - tol ||
      a.maxY < b.minY - tol ||
      b.maxY < a.minY - tol
    );
  }

  _orient(a, b, c) {
    return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  }

  _onSeg(a, b, p, tol) {
    return (
      p[0] <= Math.max(a[0], b[0]) + tol &&
      p[0] >= Math.min(a[0], b[0]) - tol &&
      p[1] <= Math.max(a[1], b[1]) + tol &&
      p[1] >= Math.min(a[1], b[1]) - tol
    );
  }

  _segmentsIntersect(a1, a2, b1, b2, tol) {
    const o1 = this._orient(a1, a2, b1);
    const o2 = this._orient(a1, a2, b2);
    const o3 = this._orient(b1, b2, a1);
    const o4 = this._orient(b1, b2, a2);

    if (Math.abs(o1) <= tol && this._onSeg(a1, a2, b1, tol)) return true;
    if (Math.abs(o2) <= tol && this._onSeg(a1, a2, b2, tol)) return true;
    if (Math.abs(o3) <= tol && this._onSeg(b1, b2, a1, tol)) return true;
    if (Math.abs(o4) <= tol && this._onSeg(b1, b2, a2, tol)) return true;

    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  }

  _distSq(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
  }

  _pointSegDistSq(p, a, b) {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) return this._distSq(p, a);
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const proj = [a[0] + t * vx, a[1] + t * vy];
    return this._distSq(p, proj);
  }

  _segmentsDistanceSq(a1, a2, b1, b2) {
    return Math.min(
      this._pointSegDistSq(a1, b1, b2),
      this._pointSegDistSq(a2, b1, b2),
      this._pointSegDistSq(b1, a1, a2),
      this._pointSegDistSq(b2, a1, a2)
    );
  }

  _areWorkRegionsAdjacent(regionA, regionB) {
    const ptsA = this._workPoints(regionA);
    const ptsB = this._workPoints(regionB);
    if (ptsA.length < 3 || ptsB.length < 3) return false;

    const span = Math.max(
      this._bounds.maxX - this._bounds.minX,
      this._bounds.maxY - this._bounds.minY,
      1
    );
    const tol = Math.max(span * 0.001, 0.02);
    const tolSq = tol * tol;

    const bA = this._boundsOf(ptsA);
    const bB = this._boundsOf(ptsB);
    if (!this._boundsNear(bA, bB, tol)) return false;

    const segA = this._segments(ptsA);
    const segB = this._segments(ptsB);
    for (const [a1, a2] of segA) {
      for (const [b1, b2] of segB) {
        if (this._segmentsIntersect(a1, a2, b1, b2, tol)) return true;
        if (this._segmentsDistanceSq(a1, a2, b1, b2) <= tolSq) return true;
      }
    }
    return false;
  }
}



// ─── Lovelace config editor ───────────────────────────────────────────────────
class SunseekerMapEditCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass   = null;
    this._renderedOnce = false;
    this._attrSignature = '';
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._renderedOnce) {
      this._render();
      this._renderedOnce = true;
      return;
    }

    // Avoid rebuilding controls while user is interacting with dropdowns/inputs.
    if (this._isInteracting()) return;

    // Only refresh when selected entity attribute keys changed.
    const entity = this._config.entity || '';
    const stateObj = entity ? this._hass.states[entity] : null;
    const sig = stateObj ? Object.keys(stateObj.attributes).sort().join('|') : '';
    if (sig !== this._attrSignature) this._render();
  }

  _isInteracting() {
    const ae = this.shadowRoot?.activeElement;
    if (!ae) return false;
    return ae.tagName === 'SELECT' || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA';
  }

  _render() {
    if (!this._hass) return;

    const entity    = this._config.entity    || '';
    const attribute = this._config.attribute || '';
    const backupPanelPosition =
      this._config.backup_panel_position === 'left'
        ? 'left'
        : this._config.backup_panel_position === 'right'
          ? 'right'
          : 'bottom';
    const stateObj  = this._hass.states[entity];
    const entities  = Object.keys(this._hass.states)
      .filter(eid => {
        const domain = eid.split('.')[0];
        if (domain === 'image' || domain === 'camera') return true;
        if (domain === 'vacuum' || domain === 'lawn_mower') return true;
        const attrs = this._hass.states[eid]?.attributes || {};
        return Object.values(attrs).some(v =>
          (typeof v === 'object' && v !== null && 'region_work' in v) ||
          (typeof v === 'string' && v.includes('region_work'))
        );
      })
      .sort((a, b) => {
        const ad = a.split('.')[0];
        const bd = b.split('.')[0];
        const ap = ad === 'image' ? 0 : ad === 'camera' ? 1 : ad === 'vacuum' ? 2 : 3;
        const bp = bd === 'image' ? 0 : bd === 'camera' ? 1 : bd === 'vacuum' ? 2 : 3;
        if (ap !== bp) return ap - bp;
        return a.localeCompare(b);
      });

    // Collect attributes that look like map data (JSON objects / long strings)
    const mapAttrs = stateObj
      ? Object.keys(stateObj.attributes).filter(k => {
          const v = stateObj.attributes[k];
          return (typeof v === 'object' && v !== null) ||
                 (typeof v === 'string' && v.length > 100);
        })
      : [];
    this._attrSignature = stateObj ? Object.keys(stateObj.attributes).sort().join('|') : '';

    this.shadowRoot.innerHTML = `
<style>
  :host { display: block; }
  .form { padding: 16px; display: flex; flex-direction: column; gap: 18px; }
  .field label {
    display: block; font-size: 11px; font-weight: 700;
    color: var(--secondary-text-color, #666);
    text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px;
  }
  select.ent-sel,
  input.ent-custom,
  select.attr-sel {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--divider-color, rgba(0,0,0,0.25));
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #111);
    font-size: 14px;
    cursor: pointer;
  }
  .hint { font-size: 12px; color: var(--secondary-text-color, #888); margin-top: 5px; }
  .warn { font-size: 12px; color: var(--warning-color, #f4b942); margin-top: 5px; }
</style>
<div class="form">
  <div class="field">
    <label>Map Image Entity</label>
    <select class="ent-sel" id="entity-sel">
      <option value="">— select entity —</option>
      ${entities.map(eid =>
        `<option value="${escHtml(eid)}"${eid === entity ? ' selected' : ''}>${escHtml(eid)}</option>`
      ).join('')}
    </select>
    <div class="hint">Or enter entity id manually:</div>
    <input class="ent-custom" id="entity-input" type="text" value="${escHtml(entity)}" placeholder="image.my_mower_map">
    <div class="hint">Pick the map-image entity from the mower device. The map JSON is read from one of its attributes.</div>
  </div>
  ${entity ? `
  <div class="field">
    <label>Map Data Attribute</label>
    ${mapAttrs.length
      ? `<select class="attr-sel" id="attr-sel">
           <option value="">— auto-detect —</option>
           ${mapAttrs.map(a =>
             `<option value="${escHtml(a)}"${a === attribute ? ' selected' : ''}>${escHtml(a)}</option>`
           ).join('')}
         </select>
         <div class="hint">Choose the attribute that holds the map JSON object.</div>`
      : `<div class="warn">No JSON attributes found on this entity yet — try again when the mower has reported data.</div>`
    }
  </div>` : ''}

  <div class="field">
    <label>Debug</label>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;text-transform:none;letter-spacing:0;font-weight:500;color:var(--primary-text-color,#111)">
      <input type="checkbox" id="debug-toggle" ${this._config.debug ? 'checked' : ''}>
      Show Import and Save JSON buttons
    </label>
    <div class="hint">Use this for troubleshooting and manual JSON import/export.</div>
  </div>

  <div class="field">
    <label>Backup Panel Position</label>
    <select class="attr-sel" id="backup-layout-sel">
      <option value="bottom"${backupPanelPosition === 'bottom' ? ' selected' : ''}>Below editor</option>
      <option value="left"${backupPanelPosition === 'left' ? ' selected' : ''}>Left side</option>
      <option value="right"${backupPanelPosition === 'right' ? ' selected' : ''}>Right side</option>
    </select>
    <div class="hint">Use side layout for tall/vertical maps.</div>
  </div>
  Version 1.0.0
</div>`;

    const es = this.shadowRoot.getElementById('entity-sel');
    if (es) {
      es.addEventListener('change', e => {
        const val = e.target.value || '';
        const cfg = { ...this._config, entity: val };
        if (!val) { delete cfg.entity; delete cfg.attribute; }
        this._fire(cfg);
      });
    }

    const ei = this.shadowRoot.getElementById('entity-input');
    if (ei) {
      ei.addEventListener('change', e => {
        const val = e.target.value.trim();
        const cfg = { ...this._config, entity: val };
        if (!val) { delete cfg.entity; delete cfg.attribute; }
        this._fire(cfg);
      });
    }

    const sel = this.shadowRoot.getElementById('attr-sel');
    if (sel) {
      sel.addEventListener('change', e => {
        this._fire({ ...this._config, attribute: e.target.value });
      });
    }

    const debugToggle = this.shadowRoot.getElementById('debug-toggle');
    if (debugToggle) {
      debugToggle.addEventListener('change', e => {
        const checked = !!e.target.checked;
        const cfg = { ...this._config, debug: checked };
        if (!checked) delete cfg.debug;
        this._fire(cfg);
      });
    }

    const backupLayoutSel = this.shadowRoot.getElementById('backup-layout-sel');
    if (backupLayoutSel) {
      backupLayoutSel.addEventListener('change', e => {
        const val = e.target.value === 'left' ? 'left' : e.target.value === 'right' ? 'right' : 'bottom';
        this._fire({ ...this._config, backup_panel_position: val });
      });
    }
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
    this._render();
  }
}

customElements.define('sunseeker-map-edit-card', SunseekerMapEditCard);
customElements.define('sunseeker-map-edit-card-editor', SunseekerMapEditCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
    type: "sunseeker-map-edit-card",
    name: "Sunseeker Map edit Card",
    preview: false,
    description: "Custom card to edit mower map",
});
