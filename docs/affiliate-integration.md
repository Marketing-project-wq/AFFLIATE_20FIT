# Integrasi Affiliate 20FIT untuk tim app

Dokumen ini untuk tim app dan backend 20FIT. Fondasi database program
affiliate (sesuai `PRD-20FIT-Affiliate-Program.pdf`) sudah ada di Supabase
"20FIT ALL DATA" (`supabase/migrations/20261009090001…090006`). Supaya
komisi benar-benar tercatat, app dan tabel order perlu disambungkan seperti
di bawah. Belum ada satu pun yang tersambung, jadi saat ini belum ada
komisi yang tercatat.

## Alur singkat

```
Affiliate bagikan  https://20fit.id/r/<KODE>/<slug-produk>
        │
        ▼
Pembeli buka link ──► app: affiliate_open_link(...)       (boleh sebelum login)
        │              setelah login: affiliate_attach_device(...)
        ▼
Checkout produk ────► app: affiliate_checkout_link(product_ref)
        │              simpan hasilnya di order.affiliate_link_id
        ▼
Order lunas ────────► trigger DB: affiliate_private.record_paid(...)
        │              komisi "Tertahan" selama pending_days (14 hari)
        ▼
Cron harian ────────► affiliate_private.release_due()  → "Tersedia"
Refund ─────────────► trigger DB: affiliate_private.record_refund(...)
```

## 1. Link `20fit.id/r/<KODE>/<slug>`

- Daftarkan path `/r/*` di `20fit.id` sebagai universal link (iOS) dan app
  link (Android) yang membuka app.
- Kalau app belum terpasang, halaman web di path yang sama mengarahkan ke
  store. Halaman ini belum dibuat (fase berikutnya).
- `slug` adalah `affiliate_product.slug`. Contohnya `open-arena` atau
  `gym-membership-1-bulan`.

## 2. Panggilan dari app (Supabase RPC)

Semua fungsi ada di schema `public` dan dipanggil dengan token pengguna.

| Kapan | Fungsi | Catatan |
| --- | --- | --- |
| Link dibuka | `affiliate_open_link(p_code, p_product_slug, p_source, p_platform, p_anon_device_id)` | Boleh tanpa login (anon). `p_source`: `whatsapp`, `instagram`, dll. kalau ada `?src=`. `p_platform`: `ios` / `android`. `p_anon_device_id`: ID instalasi acak buatan app, bukan IDFA. Mengembalikan `link_id` atau `null` kalau link tidak aktif. |
| Setelah login atau daftar | `affiliate_attach_device(p_anon_device_id)` | Memindahkan link yang dibuka sebelum login ke akun ini. |
| Saat checkout | `affiliate_checkout_link(p_product_ref)` | Mengembalikan `link_id` terakhir yang dibuka pembeli untuk produk itu, atau `null`. Simpan di order (lihat bagian 3). |

Aturan atribusi ada di database, jadi app tidak perlu menghitung:

- yang dipakai adalah link terakhir yang dibuka untuk produk yang sama;
- satu kali buka link berlaku untuk satu transaksi (`one_purchase_per_open`);
- pembelian produk lain tidak dihitung;
- pembelian oleh affiliate sendiri dibatalkan.

## 3. Kolom dan trigger di tabel order

### Tabel yang perlu disambung

Tabel di bawah dipilih sesuai produk di katalog. Status lunas yang dipakai
saat ini adalah `confirmed`.

| Tabel | Pembeli | Produk (`product_ref`) | Catatan |
| --- | --- | --- | --- |
| `arena_bookings` | `auth_user_id` | `booking_products:<booking_product_slug>` | Open Arena, Rent Arena |
| `arena_class_bookings` | `auth_user_id` | `booking_products:<booking_product_slug>` | HYROX Class |
| `arena_package_orders` | `auth_user_id` | perlu dipetakan dari `package_id` | Bundle |
| `clinic_bookings` | `auth_user_id` | `booking_products:<booking_product_slug>` atau `clinic_services:<service_id>` | Sport Massage, Physiotherapy |
| `gym_membership_orders` | `auth_user_id` | `gym_membership_plans:<plan_id>` | |
| `gym_day_pass_orders` | **tidak ada `auth_user_id`** | **tidak ada id config** (hanya `product_name`) | Perlu kolom tambahan dulu |

Untuk setiap tabel:

1. Tambah kolom:
   ```sql
   alter table public.<tabel> add column affiliate_link_id uuid references public.affiliate_link(id);
   ```
   Isi kolom ini saat order dibuat, dari `affiliate_checkout_link`.
2. Pasang trigger `after update of status`:
   - Saat status berubah menjadi lunas (`confirmed`), panggil `affiliate_private.record_paid`:
     ```sql
     perform affiliate_private.record_paid(
       p_source_table => '<tabel>',
       p_source_id    => new.id::text,
       p_item_ref     => '',                  -- isi per item kalau satu order berisi beberapa produk
       p_product_ref  => '<product_ref>',
       p_buyer        => new.auth_user_id,
       p_link_id      => new.affiliate_link_id,
       p_base_amount  => <dasar komisi, lihat bagian 4>,
       p_paid_at      => coalesce(new.paid_at, now()),
       p_channel      => new.channel);          -- hanya 'app' yang dihitung
     ```
     Fungsi ini idempoten: memanggilnya dua kali untuk order yang sama tidak
     membuat komisi kedua.
   - Saat order direfund atau dibatalkan setelah lunas, panggil
     `affiliate_private.record_refund('<tabel>', new.id::text)`.
     - Kalau komisinya masih tertahan, komisi dibatalkan.
     - Kalau sudah diklaim atau dibayar, dibuat penyesuaian negatif yang
       dipotong dari klaim berikutnya.

   Fungsi di `affiliate_private` tidak bisa dipanggil lewat API. Trigger
   harus `security definer` milik `postgres`.

### Masalah data yang perlu diputuskan tim app

- **`channel` tidak konsisten.** Nilai yang ada sekarang: `app`, `web`,
  `web_booking`, `web_voucher`, `ticket`, `manual`, `recovery_center`,
  `my20fit`, dan `null` (ada di `coach_package_orders`, `my20fit_orders`,
  sebagian `pt_package_orders` dan `gym_day_pass_orders`).
  - PRD menyatakan hanya pembelian di app yang dihitung, jadi
    `record_paid` hanya menerima `p_channel = 'app'`.
  - Tim app perlu memastikan semua checkout di app mengisi `channel = 'app'`,
    atau menentukan nilai lain mana yang dianggap app (misalnya `my20fit`).
- **Tabel tanpa kolom `channel`:** `open_arena_month_orders`,
  `my20fit_scan_orders`, `coach_bookings`.
- **Belum ada status `refunded`** di tabel-tabel di atas. Perlu disepakati
  kejadian mana yang memicu `record_refund`.
- **Status lunas berbeda:** `my20fit_orders` memakai `paid`, tabel booking
  memakai `confirmed`.

## 4. Dasar komisi (`p_base_amount`)

Sesuai PRD, komisi dihitung dari harga yang benar-benar dibayar pembeli
untuk produknya:

```
dasar = harga produk
        − diskon voucher       (discount / discount_amount / voucher_discount)
        − promo bank           (bank_promo_discount)
        − FitPoints yang dipakai (payment_splits.fitpoints_amount, cocokkan lewat booking_code / pay_ref)
dikecualikan: service_fee, payment_fee, admin_fee, PPN
```

Komisi = `floor(dasar × rate)`. Rate disimpan saat transaksi
(`rate_at_time`), jadi perubahan rate tidak mengubah komisi lama.

## 5. Konvensi `product_ref`

`affiliate_product.product_ref` menunjuk ke baris katalog sumber dengan
format `<tabel>:<kunci>`:

| Produk | `product_ref` |
| --- | --- |
| Open Arena | `booking_products:open-arena` |
| HYROX Class | `booking_products:hyrox-class` |
| Sport Massage 60 Min | `booking_products:sport-massage-60` |
| Bundle 5x Arena + Recovery | `booking_products:bundle-5arena-recovery` |
| Rent Arena | `booking_products:rent-arena` |
| Gym Day Pass | `gym_day_pass_config:<id>` |
| Gym Membership 1 Bulan | `gym_membership_plans:<id>` |
| Physiotherapy | `clinic_services:<id>` (code 003) |

Produk baru ditambahkan admin (Growth/Super) lewat
`affiliate_admin_upsert_product`. Sebuah produk baru bisa dipakai affiliate
setelah `is_active = true`.

## 6. Yang sudah berjalan di database

- **Pelepasan komisi:** `release_due()` berjalan setiap hari pukul 00.05 WIB
  (pg_cron `affiliate-release-due`).
  - Komisi yang lewat masa tahan menjadi Tersedia.
  - Komisi dengan flag fraud terbuka (`under_review`) tetap tertahan.
- **Flag fraud otomatis:**
  - banyak akun dari satu perangkat;
  - lonjakan transaksi pada satu link;
  - rasio refund tinggi;
  - rekening payout dipakai beberapa affiliate.

  Ambangnya diatur di `/admin/settings`.
- **Data bank affiliate:** dienkripsi dengan kunci di Supabase Vault. Hanya
  peran Finance/Super yang bisa membukanya, dan setiap pembukaan tercatat di
  `affiliate_audit_log`.
