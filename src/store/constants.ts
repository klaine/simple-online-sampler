export const PATTERN_COLORS = [
  // Row 1 — pastels / light
  '#f8b4b4', '#f8c9a4', '#f8e3a1', '#a8e6a3', '#a1e8d8', '#a4cff8', '#c4b4f8', '#f0b4e8',
  // Row 2 — soft
  '#f28b8b', '#f2a86b', '#f2d06b', '#7dd87a', '#6bd8c2', '#6bb0f2', '#a08bf2', '#e88bd8',
  // Row 3 — medium
  '#ef6f7a', '#f28f3b', '#f2c12e', '#57c08b', '#3dcbab', '#59a9ff', '#8b6ff2', '#d96fbf',
  // Row 4 — vivid
  '#e8445a', '#e87030', '#e8b020', '#3aad6e', '#2ab896', '#3d8ef0', '#7350e8', '#c850a8',
  // Row 5 — saturated
  '#d42848', '#d45828', '#d49818', '#289858', '#1da080', '#2878d4', '#5e38d4', '#b03890',
  // Row 6 — deep
  '#b82040', '#b84820', '#b88018', '#208048', '#188868', '#2060b8', '#4828b8', '#982878',
  // Row 7 — dark
  '#981838', '#983818', '#986810', '#186838', '#107050', '#184898', '#381898', '#801860',
  // Row 8 — very dark
  '#781030', '#782810', '#785008', '#105028', '#085838', '#103878', '#280878', '#680848',
]

/** First 8 vivid colors used for auto-assigning new patterns */
export const PATTERN_COLORS_CYCLE = PATTERN_COLORS.slice(16, 24)
export const MIN_STEP_SEMITONES = -24
export const MAX_STEP_SEMITONES = 24

export const PRESET_KITS = ['TR7x7ISH_Kit.zip', 'TR8x8ISH_Kit.zip', 'TR9x9ISH_Kit.zip']
