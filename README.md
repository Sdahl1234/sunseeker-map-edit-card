# Sunseeker Map Edit Card

A Home Assistant Lovelace card for editing Sunseeker mower map regions directly on the dashboard.

This card lets you:
- edit map polygons visually
- draw regions as polygon, circle, or ellipse
- move vertices and entire regions
- delete and undo deletions
- backup, restore, and delete map backups from the same UI
- submit the updated map to your Sunseeker integration service

## Highlights

- Home Assistant-style toolbar and dialog UX
- Aspect-ratio-safe map rendering
- Built-in region list + quick rename for work zones
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

## Drawing Modes

The card supports three draw shapes:

- **Poly**: click to place vertices, Enter/click first point to finish
- **Circle**: click-drag from center, release to place
- **Ellipse**: click-drag bounding box, release to place

New shapes are stored as region polygons in the outgoing map payload.

## Toolbar Actions

- **Select**: select, move, and edit regions
- **Delete**: click region to remove it
- **Undo**:
  - draw mode: undo last polygon point
  - delete mode: restore last deleted region
- **Done / Cancel**: finish or cancel draw operation
- **Fit**: fit map bounds to view
- **Reset**: discard in-card edits and reload from entity
- **Submit Map**: call `sunseeker.set_map`

## Backup Panel

The backup panel displays up to 5 backups from `map_backup.data`.

- Shows latest first (by `mapId`)
- Marks active map with **Current** badge
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

## Development Notes

This card is plain JavaScript (no build step) and designed for rapid iteration in `/config/www`.

If you modify the JS file:
- reload browser (hard refresh recommended)
- if needed, reload Home Assistant frontend resources

## License

Use and adapt for your own Home Assistant setup. If publishing publicly, add your preferred license in this repository.
