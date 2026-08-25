/**
 * The hour the *viewer* is standing in, and the atmosphere each hour is drawn under.
 *
 * The 3D city and the 3D atlas used to be lit as a fixed golden hour. They now follow the clock on
 * the machine looking at them: morning, day, evening (the historical look, unchanged), night.
 *
 * Two things this deliberately is not:
 *
 * - It is **not evidence**. The sun encodes nothing whatsoever about the database — a healthy
 *   instance and a failing one are lit identically at the same hour, exactly as the seeded scenery
 *   is. Every quantity either drawing claims is still computed in `cityPlan`, `cityTraffic`, and
 *   `cityFacilityTraffic`, and none of it moves when the hour does.
 * - It is **not a second palette**. Every surface in both scenes is a `MeshStandardMaterial` lit by
 *   a hemisphere/key/fill rig, so re-grading the *lights*, the sky dome, and the fog re-grades the
 *   entire drawing for free and stays physically coherent: parkland reads cool at dawn and warm at
 *   dusk off the same albedo. Four parallel copies of `CITY_COLORS` and `LANDUSE_CITY_COLORS` would
 *   be four things to keep in sync in order to say something the lighting already says.
 *
 * The one exception to that is emissive. A window is lit from the inside, so it does not follow the
 * sun and has to be stated per phase.
 *
 * Map mode is untouched by all of this. A printed basemap has no atmosphere and no sun — both
 * scenes already switch the whole rig off in the flat branch, so an atmosphere only ever reaches
 * the 3D drawing.
 */

export type TimeOfDay = 'morning' | 'day' | 'evening' | 'night'

export const TIMES_OF_DAY: readonly TimeOfDay[] = ['morning', 'day', 'evening', 'night']

/**
 * Hour the phase begins, in the viewer's own zone.
 *
 * Night wraps midnight, so it is the fallthrough rather than a range: anything that is not morning,
 * day, or evening is night. Written that way instead of as two ranges because a wrapping interval
 * expressed as `hour >= 20 || hour < 5` is the sort of thing that gets one of its two halves edited
 * and not the other.
 */
export const TIME_OF_DAY_BOUNDARIES = {
  morning: 5,
  day: 10,
  evening: 17,
  night: 20,
} as const

/** Which of the four looks the given local time falls in. */
export function resolveTimeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours()
  if (hour >= TIME_OF_DAY_BOUNDARIES.night) return 'night'
  if (hour >= TIME_OF_DAY_BOUNDARIES.evening) return 'evening'
  if (hour >= TIME_OF_DAY_BOUNDARIES.day) return 'day'
  if (hour >= TIME_OF_DAY_BOUNDARIES.morning) return 'morning'
  return 'night'
}

/** Colour and intensity of one three-point lighting rig, plus the sky it hangs in. */
export type CityAtmosphere = {
  /** Sky and ground halves of the hemisphere fill, and how hard it pushes. */
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  /** The sun (or the moon). */
  keyColor: number
  keyIntensity: number
  /**
   * Where the sun sits, as multiples of the framing-derived `reach` in `aimSunAt`.
   *
   * A low sun is the whole of a golden hour and a high one is the whole of midday, so elevation has
   * to move with the phase or morning and evening render as the same picture in different paint —
   * the shadows are the tell. The two horizontal terms swing it across the sky between them.
   */
  sunHeight: number
  sunEast: number
  sunSouth: number
  /** Bounce light opposite the key, so the shaded half of the city is not a void. */
  fillColor: number
  fillIntensity: number
  /** Clear colour behind the dome, and the haze the ground dissolves into at the horizon. */
  background: number
  fogColor: number
  /** Sky dome gradient: three stops above the horizon, two below it. */
  skyZenith: number
  skyUpper: number
  skyHorizon: number
  hazeNear: number
  hazeFar: number
  /**
   * Lit windows. These do not follow the sun — a window is lit from the inside — so they brighten
   * as the sky darkens and all but vanish at midday.
   */
  windowEmissive: number
  windowEmissiveIntensity: number
}

/**
 * The four looks for the database city.
 *
 * `evening` is the historical golden hour, value for value. It is pinned by a test so the look the
 * city has always had cannot drift while the other three are being tuned.
 */
export const CITY_ATMOSPHERE: Record<TimeOfDay, CityAtmosphere> = {
  /*
   * Morning: the sun low in the east, the air still cool and slightly blue, and the warmth confined
   * to a thin band at the horizon. The key is pale cream rather than orange — dawn light is much
   * less saturated than dusk light, and pitching it the same warm as evening is what makes a
   * "morning" mode look like evening with the sun moved.
   */
  morning: {
    hemiSky: 0xbcd2e8,
    hemiGround: 0x6f6a58,
    hemiIntensity: 2.0,
    keyColor: 0xffe4c4,
    keyIntensity: 2.0,
    sunHeight: 0.85,
    sunEast: -1.35,
    sunSouth: 0.5,
    fillColor: 0x9fb6d8,
    fillIntensity: 0.55,
    background: 0x27405e,
    fogColor: 0xc3cbd2,
    skyZenith: 0x21406e,
    skyUpper: 0x5a7cae,
    skyHorizon: 0xf6dcc0,
    hazeNear: 0xc3cbd2,
    hazeFar: 0x6f7566,
    windowEmissive: 0x24384a,
    windowEmissiveIntensity: 0.7,
  },
  /*
   * Day: sun high and near-white, blue overhead, pale haze at the horizon. Shadows are short, which
   * costs the drawing its cheapest depth cue, so the hemisphere is pulled *down* rather than up —
   * an over-lit midday flattens the massing far worse than a dim one does.
   */
  day: {
    hemiSky: 0xcfe2f5,
    hemiGround: 0x77725c,
    hemiIntensity: 1.9,
    keyColor: 0xfff6e2,
    keyIntensity: 2.6,
    sunHeight: 2.6,
    sunEast: 0.6,
    sunSouth: 0.95,
    fillColor: 0x9db4d6,
    fillIntensity: 0.45,
    background: 0x2f5f96,
    fogColor: 0xcfd8e4,
    skyZenith: 0x2b6bb5,
    skyUpper: 0x6ea3d8,
    skyHorizon: 0xd8e6ef,
    hazeNear: 0xcfd8e4,
    hazeFar: 0x77785e,
    windowEmissive: 0x1a2a38,
    windowEmissiveIntensity: 0.45,
  },
  /*
   * Evening: the original golden hour. A low warm sun against a cool sky is what gives a skyline a
   * lit face and a shaded one, and roughly half the ground is in shadow at this hour, so the
   * hemisphere is bright and only lightly cool with a warm bounce underneath.
   */
  evening: {
    hemiSky: 0xa8b6c9,
    hemiGround: 0x6a5a45,
    hemiIntensity: 1.75,
    keyColor: 0xffc286,
    keyIntensity: 2.2,
    sunHeight: 1.15,
    sunEast: 1.35,
    sunSouth: 0.6,
    fillColor: 0x8aa6d2,
    fillIntensity: 0.5,
    background: 0x131f36,
    fogColor: 0xc6a184,
    skyZenith: 0x14203c,
    skyUpper: 0x3c4a72,
    skyHorizon: 0xf0b072,
    hazeNear: 0xc6a184,
    hazeFar: 0x6d6b52,
    windowEmissive: 0x2f4f6a,
    windowEmissiveIntensity: 1,
  },
  /*
   * Night: no sun at all, a dim cool moon standing in for the key.
   *
   * The trap here is the obvious one — a night city lit only by its own windows is a black
   * rectangle, and the ~47% of ground carrying no building disappears entirely along with every
   * road, park and parcel boundary on it. So the hemisphere stays comparatively strong and slightly
   * blue: this is a moonlit city rather than an unlit one, and the drawing still has to be read.
   */
  night: {
    hemiSky: 0x5c7091,
    hemiGround: 0x2f3242,
    hemiIntensity: 1.5,
    keyColor: 0xbcd0f0,
    keyIntensity: 0.85,
    sunHeight: 2.0,
    sunEast: -1.0,
    sunSouth: -1.2,
    fillColor: 0x4a5f88,
    fillIntensity: 0.4,
    background: 0x070b16,
    fogColor: 0x2c3550,
    skyZenith: 0x03050c,
    skyUpper: 0x0d1730,
    skyHorizon: 0x3a4a70,
    hazeNear: 0x2c3550,
    hazeFar: 0x171c2b,
    windowEmissive: 0xffca7a,
    windowEmissiveIntensity: 1.9,
  },
}

/**
 * The atlas rig, which is simpler than the city's on purpose.
 *
 * There is no sky dome one level up — the clear colour *is* the sky, and matching it to the fog is
 * the whole trick that stops the landscape ending at a hard edge with a void behind it. So the two
 * are one field here rather than two that have to be kept equal by hand.
 */
export type AtlasAtmosphere = {
  /** Clear colour and fog colour at once. Deliberately not separable; see above. */
  sky: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  keyColor: number
  keyIntensity: number
}

/** The atlas at the same four hours as the cities it zooms into. `evening` is the historical dusk. */
export const ATLAS_ATMOSPHERE: Record<TimeOfDay, AtlasAtmosphere> = {
  morning: {
    sky: 0x8ea3b4,
    hemiSky: 0xc6dcee,
    hemiGround: 0x45483a,
    hemiIntensity: 1.2,
    keyColor: 0xffe6c8,
    keyIntensity: 2.6,
  },
  day: {
    sky: 0x9fb9cf,
    hemiSky: 0xd2e6f8,
    hemiGround: 0x4c5140,
    hemiIntensity: 1.25,
    keyColor: 0xfff7e6,
    keyIntensity: 3.0,
  },
  evening: {
    sky: 0x2b3a45,
    hemiSky: 0xa8cbe4,
    hemiGround: 0x35392a,
    hemiIntensity: 1.05,
    keyColor: 0xffd39a,
    keyIntensity: 3.1,
  },
  night: {
    sky: 0x121a26,
    hemiSky: 0x5b7391,
    hemiGround: 0x24261f,
    hemiIntensity: 0.95,
    keyColor: 0xc2d6f4,
    keyIntensity: 1.1,
  },
}

/** Injection seams, so the watcher can be driven by a fake clock in a test. */
export type TimeOfDayWatchOptions = {
  now?: () => Date
  intervalMs?: number
  setInterval?: (handler: () => void, ms: number) => number
  clearInterval?: (handle: number) => void
}

/** How often the clock is re-read. A phase boundary therefore lands within a minute of the hour. */
export const TIME_OF_DAY_POLL_MS = 60_000

/**
 * Calls back whenever the viewer crosses into a different phase, and returns an unsubscribe.
 *
 * Polling rather than a timer aimed at the next boundary, because the two things that break an
 * aimed timer — the machine sleeping and the clock being changed underneath it — are exactly the
 * cases where someone has a tab open long enough for this to matter at all. A minute of drift on a
 * decoration is not worth the arithmetic.
 *
 * The callback fires only on a *change*, never on the initial resolve: both scenes already apply
 * the current phase when they are built, and calling back immediately would make them do it twice.
 */
export function watchTimeOfDay(
  onChange: (phase: TimeOfDay) => void,
  options: TimeOfDayWatchOptions = {},
): () => void {
  const now = options.now ?? (() => new Date())
  const intervalMs = options.intervalMs ?? TIME_OF_DAY_POLL_MS
  const start = options.setInterval ?? ((handler, ms) => window.setInterval(handler, ms))
  const stop = options.clearInterval ?? ((handle: number) => window.clearInterval(handle))

  let current = resolveTimeOfDay(now())
  let stopped = false
  const handle = start(() => {
    // Guarded rather than trusting the clear: a fake timer in a test, and a real one that has
    // already queued a tick, both fire after the unsubscribe otherwise.
    if (stopped) return
    const next = resolveTimeOfDay(now())
    if (next === current) return
    current = next
    onChange(next)
  }, intervalMs)

  return () => {
    if (stopped) return
    stopped = true
    stop(handle)
  }
}
