
### 1.2.0 — Simulated AC commands

- Fresh v1.2 telemetry advertises simulated AC support. It has the same payload fields as v1.1 telemetry.
- v1.2 command uses the same MQTT command topic and session context, with `ac_temp_c`: 0 means OFF and integers 16–30 mean ON at the selected temperature. Fan/lamp commands continue using v1.0 or v1.1.
- `AC_ACCEPTED` means the learning module acknowledged the request. `AC_UNKNOWN` means the UART exchange could not confirm the result. F103 acts as a one-way display and remains a separate verification point.
- Deploy a console that understands v1.2 before enabling it on the device. The F413 advertises it only with the v1.1 private configuration, remote commands enabled, and a successful boot-time ZJ-IR-V2 probe.
