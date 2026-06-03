# Jade Device Registration Plan

The Branch Device Registry will support POS workstations, printer bridges,
Raspberry Pi shop checkpoints, QR displays, NFC readers, and future branch
hardware.

## Setup-Code-First Flow

1. Main Admin or authorized Admin generates a setup code in JP Admin.
2. Setup code is bound to branch, device type, and capabilities.
3. Raw setup code is displayed once.
4. Device Agent starts and asks for setup code.
5. Agent generates a keypair and safe hardware fingerprint summary.
6. Agent claims setup code through the future API.
7. Device appears in JP Admin as pending activation.
8. Admin verifies physical device details.
9. Admin activates or denies.
10. Active devices can obtain short-lived device sessions.

The scaffold simulates steps 4 through 9 locally. It does not create real
registration requests.

## Device Types

- `BRANCH_WORKSTATION`
- `POS_TERMINAL`
- `SHOP_CHECKPOINT`
- `PRINTER_BRIDGE`
- `NFC_READER`

## Capabilities

- `POS_TERMINAL`
- `PRINTER_BRIDGE`
- `SHOP_CHECKPOINT`
- `QR_DISPLAY`
- `NFC_READER`
- `BARCODE_SCANNER`

The setup code controls capabilities. The agent cannot self-declare additional
capabilities.

## Device Statuses

Scaffold UI states:

- `UNREGISTERED`
- `SETUP_CODE_ENTERED`
- `PENDING_ACTIVATION`
- `ACTIVE`
- `DISABLED`
- `ERROR`

Future API device states should include:

- `PENDING_ACTIVATION`
- `ACTIVE`
- `DISABLED`
- `DENIED`
- `REVOKED`
- `LOST`
- `REPLACED`

## API Enforcement Requirement

The Device Agent is necessary but not sufficient. Jade-Palace-API must reject
POS-sensitive requests unless they include valid active device proof.

Sensitive POS APIs should eventually require:

- user or POS session auth
- active device session
- `POS_TERMINAL` capability
- branch match
- user permission

Attendance checkpoint APIs should require:

- active device session
- `SHOP_CHECKPOINT` capability
- `QR_DISPLAY` or `NFC_READER` capability depending on action
- branch/checkpoint match

## Deferred Implementation

This scaffold intentionally defers:

- API schema and routes
- JP Admin Branch Devices UI
- JPPOS proxy integration
- POS API enforcement
- printer integration
- NFC integration
- Raspberry Pi kiosk mode
