-- External timestamp of the audit anchor (S8, optional: ANCHOR_TSA_URL). An RFC 3161 Time-Stamp Authority signs
-- the anchor's hash with its own key and clock, so a later full rewrite of the chain cannot also forge when the head
-- existed. The DER reply is kept as is: `openssl ts -verify` checks it against the TSA's certificate.
ALTER TABLE audit_anchor ADD COLUMN tsa_url TEXT;
ALTER TABLE audit_anchor ADD COLUMN tsa_reply TEXT; -- base64 DER TimeStampResp
ALTER TABLE audit_anchor ADD COLUMN tsa_at INTEGER; -- unix ms when the reply arrived
