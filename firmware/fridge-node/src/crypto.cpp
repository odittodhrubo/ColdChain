#include "crypto.h"

#include <stdio.h>
#include <string.h>

namespace {
void toHex(const uint8_t* in, size_t n, char* out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = digits[in[i] >> 4];
    out[2 * i + 1] = digits[in[i] & 0x0f];
  }
  out[2 * n] = '\0';
}
}  // namespace

#ifdef ARDUINO
// ---------------------------------------------------------------- ESP32: mbedtls (bundled with the core)
#include <mbedtls/md.h>

struct crypto::Hmac::State {
  mbedtls_md_context_t ctx;
};

crypto::Hmac::Hmac() : s_(new State) {
  mbedtls_md_init(&s_->ctx);
  mbedtls_md_setup(&s_->ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
}
crypto::Hmac::~Hmac() {
  mbedtls_md_free(&s_->ctx);
  delete s_;
}
void crypto::Hmac::begin(const char* key) {
  mbedtls_md_hmac_starts(&s_->ctx, reinterpret_cast<const unsigned char*>(key), strlen(key));
}
void crypto::Hmac::update(const char* data, size_t len) {
  mbedtls_md_hmac_update(&s_->ctx, reinterpret_cast<const unsigned char*>(data), len);
}
void crypto::Hmac::finishHex(char out[SIG_HEX_LEN + 1]) {
  uint8_t mac[32];
  mbedtls_md_hmac_finish(&s_->ctx, mac);
  toHex(mac, sizeof mac, out);
}

#else
// ---------------------------------------------------------------- native tests: portable SHA-256 (FIPS 180-4)
namespace {
constexpr uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

struct Sha256 {
  uint32_t h[8];
  uint8_t buf[64];
  size_t used;
  uint64_t bits;

  void init() {
    static const uint32_t H0[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(h, H0, sizeof h);
    used = 0;
    bits = 0;
  }
  void block(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = uint32_t(p[4 * i]) << 24 | uint32_t(p[4 * i + 1]) << 16 | p[4 * i + 2] << 8 | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
      const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      const uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e, h[5] += f, h[6] += g, h[7] += hh;
  }
  void update(const uint8_t* p, size_t n) {
    bits += uint64_t(n) * 8;
    while (n--) {
      buf[used++] = *p++;
      if (used == 64) {
        block(buf);
        used = 0;
      }
    }
  }
  void finish(uint8_t out[32]) {
    const uint64_t total = bits;
    const uint8_t pad = 0x80, zero = 0;
    update(&pad, 1);
    while (used != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; i++) len[i] = uint8_t(total >> (56 - 8 * i));
    update(len, 8);
    for (int i = 0; i < 8; i++)
      for (int j = 0; j < 4; j++) out[4 * i + j] = uint8_t(h[i] >> (24 - 8 * j));
  }
};
}  // namespace

struct crypto::Hmac::State {
  Sha256 inner, outer;
};

crypto::Hmac::Hmac() : s_(new State) {}
crypto::Hmac::~Hmac() { delete s_; }

void crypto::Hmac::begin(const char* key) {
  uint8_t k[64] = {0};
  const size_t len = strlen(key);
  if (len > 64) {
    Sha256 kh;
    kh.init();
    kh.update(reinterpret_cast<const uint8_t*>(key), len);
    kh.finish(k);
  } else {
    memcpy(k, key, len);
  }
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  s_->inner.init();
  s_->inner.update(ipad, 64);
  s_->outer.init();
  s_->outer.update(opad, 64);
}
void crypto::Hmac::update(const char* data, size_t len) {
  s_->inner.update(reinterpret_cast<const uint8_t*>(data), len);
}
void crypto::Hmac::finishHex(char out[SIG_HEX_LEN + 1]) {
  uint8_t ih[32], mac[32];
  s_->inner.finish(ih);
  s_->outer.update(ih, 32);
  s_->outer.finish(mac);
  toHex(mac, sizeof mac, out);
}
#endif

// ---------------------------------------------------------------- shared

void crypto::Hmac::update(const char* str) { update(str, strlen(str)); }

void crypto::signEnvelope(const char* secret, const char* device_id, const char* kind, uint32_t ts, const char* nonce,
                          const char* body, char out[SIG_HEX_LEN + 1]) {
  char tsBuf[12];
  snprintf(tsBuf, sizeof tsBuf, "%lu", static_cast<unsigned long>(ts));
  Hmac h;
  h.begin(secret);
  h.update(device_id);
  h.update("|");
  h.update(kind);
  h.update("|");
  h.update(tsBuf);
  h.update("|");
  h.update(nonce);
  h.update("|");
  h.update(body);
  h.finishHex(out);
}

bool crypto::constTimeEqual(const char* a, const char* b) {
  const size_t la = strlen(a), lb = strlen(b);
  uint8_t diff = la != lb;
  for (size_t i = 0; i < la && i < lb; i++) diff |= uint8_t(a[i] ^ b[i]);
  return diff == 0;
}
