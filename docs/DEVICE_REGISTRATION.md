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
6. Agent claims setup code through the Branch Device Registry API.
7. Device appears in JP Admin as pending activation.
8. Admin verifies physical device details.
9. Admin activates or denies.
10. Active devices can obtain short-lived device sessions.

R3-B-D-C implements steps 4 through 7 in the desktop Agent with the real
setup-code claim API. R3-B-D-D-B adds a manual Check Activation action for step
10 after an admin activates the pending device. R3-B-D-D-C-B starts automatic
heartbeats after successful session issue. Pending activation polling and
automatic session refresh remain deferred.

After claim succeeds, the Agent displays Waiting for Admin Activation and tells
operators to ask Main Admin or an authorized Admin to activate the device in
JP Admin -> Branch -> Devices. After admin activation, the operator presses
Check Activation to request a challenge, sign the canonical payload locally, and
receive a short-lived device session.

The setup code is never persisted after submission. The pending activation file
stores only device id, server status, branch summary, server-granted
capabilities, safe HID prefix, optional sanitized device label, and claim time.
It must not store setup codes, setup-code hashes, session tokens, token hashes,
private/public keys, full hardware fingerprint hashes, or raw API responses.

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

Server device states:

- `PENDING_ACTIVATION`
- `ACTIVE`
- `DISABLED`
- `DENIED`
- `REVOKED`
- `LOST`
- `REPLACED`

Agent registration states are separate:

- `UNREGISTERED`
- `SETUP_CODE_SUBMITTING`
- `PENDING_ACTIVATION`
- `ACTIVE_SESSION_CONNECTING`
- `ACTIVE`
- `SESSION_EXPIRED_RETRYING`
- `DISABLED`
- `DENIED`
- `REVOKED`
- `ERROR`
- `RESET_REQUIRED`

Setup code states:

- `ACTIVE`
- `CLAIMED`
- `USED`
- `EXPIRED`
- `REVOKED`
- `DENIED`

## Device-Side API Contract

Setup-code claim:

- Endpoint: `POST /api/v1/branch-devices/claim`
- Request: `setupCode`, `publicKey`, `hardwareFingerprintHash`,
  `safeHidPrefix`, `os`, `appVersion`, optional `localIp`, optional
  `deviceLabel`
- Response: `deviceId`, `status`, `branch`, `allowedCapabilities`, `message`

The agent may store the local public key as `publicKeyPem`, but the API field is
`publicKey`. Claim requests must not include arbitrary capabilities.

Session challenge:

- Endpoint: `POST /api/v1/branch-devices/session/challenge`
- Request: `deviceId`
- Response: `challenge`, `timestamp`, `expiresAt`, `signingPayload`
- Canonical payload:
  `JP_BRANCH_DEVICE_SESSION_V1\n{deviceId}\n{challenge}\n{timestamp}`

Session issue:

- Endpoint: `POST /api/v1/branch-devices/session`
- Request: `deviceId`, `challenge`, `signature`, `timestamp`
- Response: `session`, `sessionToken`

The raw `sessionToken` is sensitive and returned once. Later phases must keep
it out of renderer state, logs, persisted storage, and error objects. In this
phase the main process keeps the token in memory only, uses it for heartbeats,
and clears it on retry, failure, terminal heartbeat errors, local mock state
changes, and app quit.

Heartbeat:

- Endpoint: `POST /api/v1/branch-devices/heartbeat`
- Auth: `Authorization: Bearer <device-session-token>`
- Request: optional `appVersion`, optional `localIp`
- Response: `ok`, `device`, `session`
- Desktop Agent cadence: every 45 seconds after a successful session issue
- API unavailable/rate-limited failures: reconnecting with backoff
- disabled/denied/revoked/not-active/token-boundary failures: token cleared and
  device locked for reset/admin review

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

This phase intentionally defers:

- pending activation status polling
- automatic active device session challenge/sign/issue refresh
- JPPOS proxy integration
- POS API enforcement
- printer integration
- NFC integration
- Raspberry Pi kiosk mode
