-- Device secret rotation (S7). An Admin's rotation stores the new secret as pending and sends it to the device,
-- sealed under the current one (ROTATE_SECRET). The first message signed with the pending secret proves the device
-- switched: the pending secret becomes the secret (one UPDATE) and the old one is refused from then on.
ALTER TABLE devices ADD COLUMN pending_secret_enc TEXT;
ALTER TABLE devices ADD COLUMN secret_rotated_at INTEGER; -- unix ms of the last completed rotation
