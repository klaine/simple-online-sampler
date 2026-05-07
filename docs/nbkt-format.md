# NI Battery 4 `.nbkt` Monolith Format

Reverse-engineered from 3 factory kits: DMX Kit (25 samples), Apparat Kit (62 samples), Studio Gong Kit (318 samples).

## Top-Level Structure

```
[MTD Header]  →  [TOC Entries]  →  [WAV Data]  →  [Trailing Patch Data]
```

### MTD Header

```
0x000: "MTD\0" marker (4 bytes)
0x084: uint32 version = 2
0x108: F0 sentinel byte
0x110: uint32 entry_count (number of TOC entries)
0x118: uint64 total_wav_data_size
0x120: "TOC\0" marker (start of TOC section)
```

### TOC Entries (0x280 bytes each)

```
0x000–0x1FF: UTF-16LE filename (null-padded)
0x260:       uint64 wav_chunk_size (RIFF data size, not offset)
0x268:       uint32 sequential_index (starts at 2; F1 sentinel = patch.nbkt ref)
```

- Entries are sequential; WAV data is concatenated in TOC order
- DMX Kit has a special "patch.nbkt" entry (F1 sentinel in index field); other kits lack this

### WAV Data

Plain concatenated RIFF/WAVE chunks (PCM, no LIST/INFO tags). Mono or stereo, 16-bit, 44100 Hz. When the last RIFF size is odd, a 1-byte pad aligns the trailing data.

---

## Trailing Patch Data

Starts immediately after the last WAV chunk. Contains the full Kontakt-style instrument definition.

### Outer Container

```
+0x00: uint32 self_size (total trailing data size)
+0x04: 00 00 00 00
+0x08: uint32 = 1
+0x0C: "hsin" marker (4 bytes)
+0x10: uint32 version = 1
+0x14: uint32 flags = 0
+0x18: UUID (16 bytes, binary)
+0x28: 0x96 constant
+0x30: Nested DSIN containers (fixed layout)
+0x80: Magic bytes 0D 62 65 85 (constant across all kits)
+0x88: 0E 70 10 00 (constant)
+0xA8: uint32=3 + UTF-16LE "000"
+0xCA: 4KIN(v3) — MAIN DATA CONTAINER (variable size)
```

All kits have exactly **18 DSIN**, **7 hsin**, and **4 4KIN** markers — the container hierarchy is fixed regardless of sample count.

### DSIN Header (12 bytes)

```
Bytes 0–3:  "DSIN" (ASCII)
Bytes 4–7:  uint32LE type — character code: 'm'=0x6D, 't'=0x74, 's'=0x73, or integer
Bytes 8–11: uint32LE content_size
```

### hsin Header

```
Bytes 0–3:   "hsin" (ASCII)
Bytes 4–7:   uint32LE version = 1
Bytes 8–11:  uint32LE flags = 0
Bytes 12–27: UUID (16 bytes)
```

### DSIN Layout Within 4KIN(v3)

```
DSIN 'v'  — 20 bytes, version info
DSIN 'j'  — 20 bytes
DSIN 0x01 — 20 bytes, metadata node
DSIN 'e'  — 20 bytes, contains:
  +0x163: UTF-16LE "4.3.1.0" (Kontakt version)
  +0x1EF: UTF-16LE kit_name
  +0x201: UTF-16LE "Native Instruments"
  +0x27D: UTF-16LE "Battery"
  +0x28F: UTF-16LE "Battery 4 Factory Library"
DSIN 'l'  — variable (622–652 bytes), KSP script metadata
DSIN 'y'  — 104 bytes, fixed metadata
DSIN 't'  — VARIABLE, ALL CELL/INSTRUMENT DATA (the big one)
```

### 4KIN(v4) Footer (322 bytes, constant layout)

```
+0x70: "4taB" (Battery reverse tag)
+0x7C: uint32LE cell_count_with_flag — actual count = value & 0x7FFFFF (bit 23 always set)
+0x82: uint32LE total_wav_data_size (sum of all WAV 'data' chunk sizes)
Contains: "Kontakt2\0", "(null)\0", two UUIDs (unique per kit)
```

---

## DSIN 't' Blob — FastLZ Compressed

### Compression

**NI FastLZ Level 2** (LZ77 variant). Confirmed via `fastlz_decompress` symbol in Battery 4 VST3 binary.

| Kit | Compressed | Decompressed | Ratio |
|-----|-----------|-------------|-------|
| DMX Kit | 50,805 bytes | 678,331 bytes | 13.3× |

Compressed data starts at **content + 0x71** (113 bytes into the DSIN 't' content). The first 0x71 bytes are a pre-compression header.

**Note:** Factory kits (Apparat, Studio Gong) are encrypted via NI's `EncryptionItem` system. User-created .nbkt files are NOT encrypted.

### FastLZ Level 2 Decompressor

```python
def fastlz_decompress(src, max_out=10*1024*1024):
    out = bytearray()
    p = 0
    n = len(src)
    try:
        while p < n and len(out) < max_out:
            b = src[p]; p += 1
            op = b >> 5
            if op == 0:
                # Literal run: low 5 bits + 1 = count
                cnt = (b & 0x1F) + 1
                out.extend(src[p:p+cnt]); p += cnt
            elif op < 7:
                # Short match: opcode = length - 2, offset from next byte
                ln = op + 2
                off = ((b & 0x1F) << 8) + src[p] + 1; p += 1
                for _ in range(ln): out.append(out[-off])
            else:
                # Long match: length from extended encoding
                ln = b & 0x1F
                if ln == 31:
                    while src[p] == 255: ln += 255; p += 1
                    ln += src[p]; p += 1
                ln += 9
                off = (src[p] << 8) + src[p+1] + 1; p += 2
                for _ in range(ln): out.append(out[-off])
    except IndexError:
        pass
    return bytes(out)
```

### Full Extraction Code

```python
import struct

with open("DMX Kit.nbkt", "rb") as f:
    nbkt = f.read()

# DMX Kit: trailing patch at 0x21FFE4, DSIN 't' at 0x220455
dsin_off = 0x220455

magic = nbkt[dsin_off:dsin_off+4]                          # b'DSIN'
dtype = struct.unpack_from('<I', nbkt, dsin_off+4)[0]       # 0x74 = 't'
content_size = struct.unpack_from('<I', nbkt, dsin_off+8)[0]  # 0xC675

content = nbkt[dsin_off+12 : dsin_off+12+content_size]

# Compressed data starts at content+0x71
compressed = content[0x71:]
decompressed = fastlz_decompress(compressed)
# Result: 678,331 bytes
```

---

## Decompressed Blob Structure

### Root Hierarchy

```
0x000000: uint32 size = 0x0A59BB (677,307)
0x000004: padding (8 bytes)
0x00000C: "hsin" — root container
0x000030: DSIN type=0x01 size=1
0x00004C: DSIN type='m' size=0xA5967 — main instrument container
  0x000060: "hsin" — instrument UUID
  0x000084: DSIN type='m' size=1
  0x000098: DSIN type=0x01 size=1
  ... instrument data ...
```

### Instrument Header (~0x100)

```
0x13E: uint32 char_count (instrument name length)
0x142: UTF-16LE instrument_name (e.g. "DMX Kit")
0x158: float32 1.0 (gain?)
0x15C: float32 0.0
0x160: float32 1.0
0x164: 01 7F 00 7F FF FF 00 F0 — MIDI range (noteHigh=127, noteLow=0, velHigh=127)
0x184: UTF-16LE "(null)" — author
0x194: UTF-16LE "Kontakt2" — engine
0x1A4: UTF-16LE "(null)" — URL
```

### Parameter Sections

Recurring pattern `01 25 00 XX` marks parameter group blocks:

```
01 25 00 SIZE(1 byte) 00 00 00 01 50 00 16 00 00 00 PARAM_ID(U32 LE) ...
```

Each contains float values and flags for one K2 parameter group.

### KSP Scripts (~0x02C000)

5 KSP scripts totaling ~56KB. Labels like `"Battery 3 script N"`, `"Slot 1 (Group Start)"`, etc. References: `$ENGINE_PAR_GROUP_DYNAMICS`, `ENV_AHDSR_VOLUME`, `DBD_PITCH`, `LFO_SINE`.

KSP variable storage follows scripts:
```
"%onoff_store 0"
"%timing_store 49"
"%velocity_store 51"
"%tuning_store 60"
"%volume_store 37"    ← zone reference ID for Kick DMX
```

### Zone Parameter Table (~0x02CFB0)

136 entries × 12 bytes each:

```
Bytes 0–3:  00 00 00 08 (marker)
Bytes 4–7:  00 00 00 [04|40] (parameter type)
Bytes 8–11: 00 00 00 00 (value — all zeros = defaults in DMX Kit)
```

---

## Cell Block Format

128 cell blocks fill the space between zone parameters and sample table. Battery's grid is 8 banks × 16 pads = 128 cells.

### Named Cell Structure

```
Bytes 0–3:    FF FF FF FF           — cell marker sentinel
Bytes 4–7:    uint32LE byte_size    — size of name region
Bytes 8–11:   uint32LE char_count   — UTF-16 characters (including null)
Bytes 12+:    UTF-16LE name         — e.g. "Kick DMX\0"
+name_end:    00 00 80 3F           — float 1.0
+name_end+4:  00 00 00 00           — float 0.0
+name_end+8:  00 00 80 3F           — float 1.0
+name_end+12: flags (10 bytes)
+name_end+22: FF FF FF FF           — another sentinel
+name_end+26: sub-header (10 bytes)
```

**byte_size** = `char_count(4) + name_bytes(char_count*2)`. Total name header = `4(marker) + 4(byte_size) + byte_size`.

### Cell Content (3743 bytes, after name header)

Identical template for all cells except 6 bytes. Contains:

**Modulator chain** (5 modulators per cell):
1. `"volume"` → `ENV_AHDSR_VOLUME` → `ENV_AHDSR`
2. `"pitch"` → `ENV_DBD_PITCH` → `ENV_DBD`
3. `"volume"` → `LFO_SINE_VOLUME` → `LFO_SINE`
4. `"volume"` → `ENV_AHDSR_VOLUME` → `ENV_AHDSR` (2nd instance)
5. `"volume"` → `LFO_SINE_VOLUME` → `LFO_SINE` (2nd instance)

Then:
6. `"volume"` → `VEL_VOLUME` (velocity→volume mapping)
7. `"pitch"` → `VEL_PITCH` (velocity→pitch mapping)

**Category/ID triple** at content+3006:
```
00 01  CC 00 00 00  ZZ 00 00 00  ZZ 00 00 00  01 07 00 00 00 FF FF FF FF
       ^category    ^zone_ref    ^zone_ref     ^sentinel
```

### The 6 Varying Byte Offsets (relative to content start)

| Offset | Hex | Size | Field | Notes |
|--------|-----|------|-------|-------|
| 584 | 0x248 | uint32 | Zone ID | K2 internal; bit 8 (0x100) set for velocity-layered cells |
| 786 | 0x312 | uint32 | Group ID | Always = Zone ID + 1 |
| 1050 | 0x41A | uint32 | Object ID | Sequential (302–329 in DMX), position in K2 global object table |
| 3006 | 0xBBE | uint32 | Category Code | Drum type classification (see table below) |
| 3010 | 0xBC2 | uint32 | Zone Reference | Sequential per named cell; matches KSP `%volume_store` values |
| 3014 | 0xBC6 | uint32 | Zone Reference | Always = @3010 (duplicate) |

### Category Codes

| Code | Drums |
|------|-------|
| 0 | Crash / unassigned |
| 16 | Header/base zone only |
| 17 | Kick, Sidestick, LowTom, Shaker |
| 19 | Tambourine, Clap |
| 23 | ClosedHH, OpenHH |
| 24 | HiTom, Ride |
| 31 | Snare |

### Empty/Default Cells

104 unnamed cells with the same 3743-byte template, category=0, and sequential IDs filling gaps between named cells.

---

## Cell → Sample Mapping

**By name, not by index.** Cell name `"Kick DMX"` matches sample `"Kick DMX.wav"` in the filename table. Velocity layers detected by `V1`/`V2` suffix on filenames matching the same cell base name.

No explicit index references between cells and samples were found — linkage is purely name-based.

---

## Sample Filename Table (~0xA5200 in decompressed blob)

### Entry Format

```
01 00 00 00 04  CHARCOUNT(uint32LE)  UTF-16LE_FILENAME  NULL_PADDING
```

5-byte prefix `01 00 00 00 04` per entry. Fixed-width slots (~61 bytes total per entry).

### DMX Kit Entries (26 total)

```
 0: DMX Kit.nbkt           (self-reference)
 1: Kick DMX.wav
 2: Clap DMX.wav
 3–13: remaining samples
14–25: DMXX variant samples
```

### Additional References

Before the table: IR/reverb paths (`"Impulse Responses"`, `"BTIR.nkx"`, `"2.1s Long Ambience.wav"`).

After the table: file path with `02` type markers:
```
02 05 00 00 00 "Users" (UTF-16LE)
02 0A 00 00 00 "kajo.laine" (UTF-16LE)
```

### Footer

Decompressed data ends with: `0D 62 65 85 01 00 00 00 00 00 00`

12-byte footer after compressed data in raw .nbkt: `01 00 00 00 00 00 00 00 E9 03 00 00` (0x3E9 = 1001, possibly version).

---

## DMX Kit Cell Data Table

```
Name                   @584  @786 @1050  @3006 @3010 @3014
Kick DMX                  3     4   302     17    37    37
Tamb DMX                  6     7   303     19    38    38
Snare DMX                 8     9   304     31    39    39
Clap DMX                 10    11   305     19    40    40
Sidestick DMX            12    13   306     17    41    41
LowTom DMX               14    15   307     17    42    42
Shaker DMX               16    17   308     17    43    43
HiTom DMX                22    23   309     24    44    44
ClosedHH DMX            264   265   310     23    45    45  ← velocity layers (0x100 flag)
Ride DMX                 36    37   311     24    46    46
OpenHH DMX               24    25   312     23    47    47
Crash DMX                38    39   313      0    48    48
(4 empty cells, IDs 314–317)
Kick DMXX               294   295   318     17    49    49  ← 0x100 flag
Tamb DMXX               276   277   319     19    50    50  ← 0x100 flag
Snare DMXX              270   271   320     31    51    51  ← 0x100 flag
Clap DMXX                42    43   321     19    52    52
Sidestick DMXX           44    45   322     17    53    53
LowTom DMXX              46    47   323     17    54    54
Shaker DMXX              48    49   324     17    55    55
HiTom DMXX               50    51   325     24    56    56
ClosedHH DMXX           288   289   326     23    57    57  ← 0x100 flag
Ride DMXX                54    55   327     24    58    58
OpenHH DMXX              56    57   328     23    59    59
Crash X                  58    59   329      0    64    64
```

---

## Limitations

- **Factory kits are encrypted** via NI's `EncryptionItem` — only user-created .nbkt files can be fully parsed
- **DMX Kit has all default audio parameters** — per-cell volume, pan, tune, filter, envelope offsets not yet mapped (would need a kit with customized settings)
- Per-cell record size is **variable-length**, not fixed across kits
- The NI serialization format within cells uses a proprietary tag-value encoding that has not been fully decoded
