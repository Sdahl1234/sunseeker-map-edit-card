# Sunseeker Map Edit Card

A Home Assistant Lovelace card for editing Sunseeker mower map regions directly on the dashboard.

This card lets you:
- edit map polygons visually
- draw regions as polygon, circle, or ellipse
- move vertices and entire regions
- delete and undo deletions
- add a brand new work zone and follow the Bluetooth recording live
- backup, restore, and delete map backups from the same UI
- submit the updated map to your Sunseeker integration service

## Highlights

- Home Assistant-style toolbar and dialog UX
- Aspect-ratio-safe map rendering
- Built-in region list + quick rename for work zones
- Live progress panel with cancel button while a new work zone is recorded
- Live mower position and heading drawn on the map
- Backup panel with thumbnails, current map badge, and restore/delete actions
- Optional debug mode for JSON import/export

## Requirements

- Home Assistant with the Sunseeker custom integration installed
- A map entity (typically in the `image` domain) exposing map attributes such as:
  - `map_data` / `map`
  - `map_id`
  - `map_backup`
- Sunseeker services available:
  - `sunseeker.set_map`
  - `sunseeker.backup_map`
  - `sunseeker.restore_map`
  - `sunseeker.delete_backup`
  - `sunseeker.cancel_add_work_area`
  - `sunseeker.refresh_map`
- For adding work zones: a mower on MODEL_X / MODEL_S and Bluetooth reachable from Home Assistant

## Installation (via HACS)

1. Add this repository to HACS as a custom frontend (plugin) repository.
2. Install the cards via HACS → Frontend.
3. Use in your dashboard:

```yaml
type: 'custom:sunseeker-map-edit-card'
```


## Manual Installation


### 1) Copy files

Place the card JS file in your Home Assistant `www` path:

```text
/config/www/sunseeker-map-edit-card/sunseeker-map-edit-card.js
```

### 2) Add Lovelace resource

Settings -> Dashboards -> Resources -> Add Resource

- URL: `/local/sunseeker-map-edit-card/sunseeker-map-edit-card.js`
- Resource type: `JavaScript Module`

### 3) Add the card

Use Manual card and paste:

```yaml
type: custom:sunseeker-map-edit-card
entity: image.your_sunseeker_map
attribute: map_data
debug: false
backup_panel_position: bottom
```

<img width="1563" height="605" alt="image" src="https://github.com/user-attachments/assets/d780354b-82b7-4665-8921-036847658722" />


## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | string | required | Map image entity from your Sunseeker integration |
| `attribute` | string | auto-detect | Attribute containing map JSON |
| `debug` | boolean | `false` | Shows Import + Save JSON buttons |
| `backup_panel_position` | string | `bottom` | Backup panel position: `bottom`, `left`, or `right` |
| `ble_status_entity` | string | auto-detect | `sensor.*_ble_status` entity used for the add-zone progress panel and the live mower position |
| `mower_image` | string | auto-detect | URL of an image drawn at the live mower position. Auto-detected from the integration's "Mower image" entity when left empty; falls back to a simple drawn shape if none is found. |

## Drawing Modes

The card supports three draw shapes:

- **Poly**: click to place vertices, Enter/click first point to finish
- **Circle**: click-drag from center, release to place
- **Ellipse**: click-drag bounding box, release to place

New shapes are stored as region polygons in the outgoing map payload.

## Toolbar Actions

- **Select**: select, move, and edit regions
- **Merge**: select two adjacent work zones to merge them
- **Split**: draw a line across one work zone to split it
- **Delete**: click region to remove it
- **Draw**: draw a new region of the selected type
- **Route**: draw the drive route from the charger to a new work zone
- **Undo**:
  - draw mode: undo last polygon point
  - delete mode: restore last deleted region
- **Done / Cancel**: finish or cancel draw operation
- **Fit**: fit map bounds to view
- **Reset**: discard in-card edits and reload from entity
- **Submit Map**: call `sunseeker.set_map`

## Adding a Work Zone

A new work zone cannot be created from map data alone. The mower has to physically
drive the outline of the new zone while Home Assistant is connected to it over
Bluetooth. The card prepares everything, the integration then runs the BLE session.

### What is required

- The map must be **clean** — submit or reset any other pending edits first
- Only **one** new work zone per submit
- The new zone needs a **route**: the path the mower drives from the charger to the
  first point of the new zone
- The mower must be **docked** when you submit
- Bluetooth connection between Home Assistant and the mower for the **whole** session

### Merge vs. new zone

What happens to a drawn outline depends entirely on where you draw it, not on anything
you pick in the card:

- **Drawn touching or overlapping an existing work zone** → it's merged into that zone.
- **Drawn away from any existing zone** → it becomes its own new, separate zone.

> **A brand-new (non-merged) zone has no passage back to the charger.**
> The route you draw in step 2 only gets the mower *to* the new zone — it does not
> become a permanent passage. Once the zone is recorded, you must draw a **Passage**
> (↔️ in the Draw type dropdown) connecting the new zone to an existing one (or to the
> charger's route), otherwise the mower may not be able to find its way home after
> mowing that zone.

### Steps

1. Press **Draw**, choose **🌱 Work Zone** in the type dropdown and draw the outline
   of the new zone. Finish with **Done** or Enter.
2. The card automatically switches to **Route** mode. Click the route points the
   mower drives from the charger to the new zone, then press **Done**.
3. Press **Submit Map** and confirm.
4. The progress panel appears and follows the mower through the phases
   (Connect → Pre-flight → Remote control → Navigation → Recording → New zone id → Commit).
   The mower is drawn on the map with its live position and heading.
5. When the session finishes, the map is reloaded from the entity and the new zone
   appears in the region list, where you can rename it.

Press **✗ Cancel** in the progress panel at any time to abort. The mower stops and
drives back to the charger.

### Important notes

> **Route points are only accurate to about 50 cm.**
> Place them with enough clearance so the mower cannot bump into anything. During
> navigation the mower is effectively blind — it will **not** stop for a wall, a
> tree, a flower bed or a step. Keep well away from obstacles, and prefer a few
> extra route points over long straight legs through narrow passages.

> **The Bluetooth connection must hold for the entire session.**
> The mower drives away from the dock, so the connection has to survive across the
> whole route and the complete outline of the new zone. If the link drops, the
> session aborts.

### No Bluetooth coverage across the whole garden?

If Home Assistant (or an ESPHome BLE proxy) cannot reach the mower everywhere it
will drive, use a BLE proxy that travels with the mower:

[Zen3515/homeassistant-mobile-ble-proxy](https://github.com/Zen3515/homeassistant-mobile-ble-proxy)

It turns an Android phone into a Home Assistant Bluetooth proxy. Install it on a
spare phone and tape the phone on top of the mower — the proxy then stays within
centimetres of the mower for the whole session, and Home Assistant talks to the
mower over Wi-Fi through the phone.

## Backup Panel

The backup panel displays up to 5 backups from `map_backup.data`.

- Shows latest first (by `mapId`)
- Marks active map with **Current** badge
- **Refresh** calls `sunseeker.refresh_map` to force the integration to re-fetch
  both the map and the backup list from the server. Use this if a backup, restore,
  or new work zone doesn't show up right away — the mower can take a few seconds
  to upload the updated map to the server after the request.
- **Backup Current** creates a backup for the current `map_id`
- **Restore** restores selected backup
- **Delete** removes selected backup

## Region Support

Editable region types:
- `region_work`
- `region_channel`
- `region_forbidden`
- `region_obstacle`
- `region_placed_blank`

Read-only region:
- `region_charger_channel`

## Example Dashboard Card

```yaml
type: custom:sunseeker-map-edit-card
entity: image.lawn_mower_map
attribute: map_data
backup_panel_position: right
debug: false
```

## Troubleshooting

### Card not loading

- Verify resource URL is exactly:
  `/local/sunseeker-map-edit-card/sunseeker-map-edit-card.js`
- Hard refresh browser cache
- Check browser console for JS errors

### No map appears

- Confirm selected `entity` exists
- Ensure entity attributes include map JSON (`map_data` or equivalent)
- Try leaving `attribute` empty so auto-detect can pick the map attribute

### Submit/backup/restore fails

- Confirm Sunseeker integration services are registered
- Verify card `entity` belongs to the same mower/device context expected by the integration
- Check Home Assistant logs for service-call exceptions

### Adding a work zone fails or shows no progress

- **Submit is refused**: the map must be clean and the new zone must have a route
- **No progress panel**: set `ble_status_entity` manually if the `sensor.*_ble_status`
  entity could not be auto-detected
- **Session aborts mid-way**: usually lost Bluetooth coverage — see the mobile BLE
  proxy suggestion above
- **Mower does not leave the dock**: it must be docked and idle when you submit

## Development Notes

This card is plain JavaScript (no build step) and designed for rapid iteration in `/config/www`.

If you modify the JS file:
- reload browser (hard refresh recommended)
- if needed, reload Home Assistant frontend resources

## License

Use and adapt for your own Home Assistant setup. If publishing publicly, add your preferred license in this repository.
