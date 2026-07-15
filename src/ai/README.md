# AI logic & decision tree

This is the map of how the bots think. It documents the whole `src/ai/` stack —
every decision, in the order it's actually made each tick — so you don't have to
reconstruct it from four files. Where a number matters it's named and given; the
source of truth is always the constant in the cited file.

The AI is a **four-layer inheritance chain**, each layer adding one capability and
overriding a couple of hooks from the one below:

```
Character (entities/actor.ts)      — body, gun, movement, HP, z-level
   └── Robot        (robot.ts)     — sight, reaction, aim easing, fire, wander        [a turret]
        └── Oracle  (oracle.ts)    — nav-graph movement toward a chase target          [it hunts]
             └── TacOracle (tacoracle.ts) — real gun, burst discipline, shoot/cover/run/heal  [it soldiers]
                  └── DominationOracle (domoracle.ts) — works capture points when not fighting  [it plays the mode]
```

Everything below a layer is inherited unchanged unless noted. A level spec picks
which class to spawn and with what options (`RobotOptions` → `OracleOptions` →
`TacOracleOptions`).

Two orthogonal facts about a robot:

- **Gun realism.** `realGun: false` (default) wraps the gun in an `EnemyGun`:
  flat uniform spread, infinite ammo, no reloads — a dumb turret. `realGun: true`
  (all Oracles set it) wields the gun *for real*: the player's deterministic
  recoil pattern, a finite magazine, hardcore reloads. Only real-gun AIs run the
  burst/reload/mode machinery.
- **Humanising knobs.** `reactionTime` (ticks a change must persist before it's
  acted on), `stagger` (plan only every Nth tick, phase-offset per bot),
  `aimSigma` (Gaussian aim wobble, worse up close). `0 / 1 / 0` = the inhuman
  launch-day slickness; the Tac defaults are `15 / 5 / —`.

---

## The per-tick pipeline (`Robot.think`, robot.ts)

Every character runs this **every tick**, at 60 Hz. The expensive *planning* is
throttled by `stagger`; aiming and firing are not, so combat stays smooth even
when a bot only re-plans every 5th tick.

```
think(ai):
  1. PLAN or COAST
       if (stagger <= 1) or ((tick + thinkPhase) % stagger == 0):  decide(ai)   ← full, expensive
       else:                                                        coast(ai)    ← cheap continuation
  2. postMove(ai)          ← continuous steering hook (currently a no-op; see "Crowd spacing")
  3. AIM (every tick)
       target = lastTarget if still alive else null
       if target: aimAngle = angle to (target.pos + aimError)     ← jittered point, not the true target
       angle = turnToward(angle, aimAngle)                        ← eased, never snaps (TURN_GAIN 0.05 + 2° floor)
       forward = fromAngle(angle)
  4. FIRE (every tick)
       if shouldFire(ai, target) and gun.fire(world): onFired()
```

`decide()` picks the *desired* heading and the movement for this plan; the actual
heading eases toward it every tick, and the trigger is pulled every tick it's
allowed. `lastTarget` is the bridge: `decide` sets it, the between-plan ticks aim
and fire at it.

### `decide()` — acquire, react, act

```
decide(ai):
  gain = stagger                       ← clocks tick in real time even when planning is throttled
  spotted = selectTarget(ai)           ← subclass hook: who to engage (may be null)
  seenFor += gain if spotted else -gain, clamped to [0, reactionTime]
  target = spotted  if seenFor >= reactionTime  else null   ← reaction gate

  aimError = 0 if no target; else resample on target switch or every AIM_RESAMPLE_TICKS

  if target:                 alerted = true; ticksSinceTarget = 0
  elif not alerted and standing still:   wander (idle random turns every 1–3 s)
  else:                      hold the last aim ("on alert", lost sight)

  ticksSinceTarget += gain  when no target
  act(ai, target)           ← THE decision tree, overridden per layer
  lastTarget = target
```

Key idea: **`seenFor` is a leaky clock, not a flag.** A one-tick blink of the
enemy around a corner doesn't reset acquisition; a long occlusion does. And
`ticksSinceTarget` is how long since anyone was in sight — it drives how long the
last combat aim is held before facing follows movement again.

---

## Sight (`Robot`, robot.ts)

All targeting is built on two primitives, both **z-aware** (a balcony guard on
z=1 can neither see nor hit a target on z=0):

- `visibility(world, target)` — of the target's **5 sample points** (its centre +
  4 bounding-box corners, `targetPoints`), how many have an unobstructed ray from
  here. `0` = fully hidden, `5` = fully exposed. Partial cover is a number in
  between and it matters (see lane scoring).
- `canSee` = `visibility > 0`.

`hostiles(ai)` is the living enemies per the team registry. `nearestVisibleHostile`
(base Robot's target pick) and `nearestHostile` (any z, seen or not) are the dumb
distance-based selectors; smarter layers replace them.

---

## Layer 1 — `Robot`: the turret

The base `act()` is **empty** — a Robot doesn't move. Its whole behaviour is the
pipeline above with the default hooks:

- `selectTarget` = `nearestVisibleHostile` (closest visible enemy on my z).
- `shouldFire` = `target != null` (fire whenever something is in sight).
- Turns smoothly toward it, sprays its flat `EnemyGun` spread.

That's it: a reaction-gated, smoothly-turning sentry. Everything else is movement
and gun discipline added by subclasses.

---

## Layer 2 — `Oracle`: navigation

The Oracle adds **movement toward a chase target over the level's nav graph**
(`world/nav.ts`: a baked all-pairs Dijkstra table, O(1) `route(from,to)` → next
hop + total distance). It still aims/fires like a Robot.

```
Oracle.act(ai, target):
  chase = target ?? nearestHostile(ai)     ← move at the seen target, else the nearest enemy anywhere
  if chase: navChase(ai, chase, target)
coast(ai): coastStep(ai)                   ← one more step toward the committed destination, no path query
```

### `navChase` — the movement policy

The graph is **authoritative even with the target in sight**. Two questions drive
every plan:

- **Which node am I at?** `nearestWalkable` — the nearest node I can actually walk
  a straight body-width line to (sight is *not* proof of reachability: a fence is
  see-through but solid).
- **Which node is the target at?** `nearestInSight` — the nearest node that *sees*
  the target.

```
navChase:
  if graph present:
     updatePlan()                          ← refresh the committed waypoint (below)
     if atGoalNode and (target or same z): direct = true, dest = chase.pos   ← beeline, but only inside the shared cell
     elif waypoint >= 0:                    dest = node[waypoint].pos          ← walk the route, hop by hop
  elif target:                              direct = true, dest = target.pos   ← no graph: just walk at it
  if beelining and within standoffFor(chase): STOP        ← fight at gun length, don't hug
  step toward dest at stepSpeed()
  if beeling and the step would cross a stair midpoint (flip z): DON'T        ← anti stair-flicker rule
  face: if blind for > AIM_HOLD_TICKS, aim via lookahead (pre-aim the corner ahead) or straight down travel
```

Two rules exist because of specific bugs, and both matter:

1. **Beeline only within the shared node cell** (`atGoalNode`). Dashing straight at
   a *merely visible* target that's actually a room away used to cross a staircase,
   flip z, drop the target, re-route, flip back — rapid stair flicker.
2. **A direct step never crosses a stair midpoint.** Level changes happen only on
   sanctioned waypoint legs.

### `updatePlan` / `plan` — committing a route

```
updatePlan:
  if at the committed intermediate waypoint (within ARRIVE_EPS): drop it, pick the next now
  if no waypoint or the REPLAN_TICKS timer fired: plan()
  skipReachableHops()                       ← string-pulling

plan (one path query):
  goal = nearestInSight(chase);  curr = nearestWalkable(me)
  if curr == goal: waypoint = goal, atGoalNode = true      ← beeline regime
  else: fresh = the route's next hop (or curr if that hop isn't walkable straight from here)
        STICKY HOP: only switch off the previously-committed hop if the fresh plan is
                    cheaper by more than SWITCH_MARGIN (else keep it) — kills hairpin oscillation
                    at cell boundaries where "my node" flip-flops.
```

- **Commit-until-arrival** stops sight-blinking from making the bot dither between
  two nodes.
- **`skipReachableHops` (string-pulling)** cuts corners: while the hop *after* the
  current waypoint is already reachable in a clear straight line from where I
  actually stand, advance to it (bounded `MAX_SKIP` per tick, forward-only, so it
  can't oscillate). This is why paths look smooth instead of node-to-node zig-zag.
- **`lookahead`** points the gun at the farthest node within `FACE_NEXT_DISTANCE`
  along the route, so the muzzle clears a corner before the body does.

`standoffFor(chase)` is the beeline stop distance (default `DEFAULT_STANDOFF`); a
subclass overrides it to walk right onto a destination instead of hovering short.

---

## Layer 3 — `TacOracle`: the soldier

This is where most of the intelligence lives. The TacOracle wields a **real gun**
and its whole behaviour is about managing that gun: bursts, reloads, cover, and
knowing when a fight is even on. It has a **posture state machine** on top of the
Oracle's movement.

### 3a. Gun discipline — burst control

The trigger is trained, not scripted. A burst continues only while the **spray
envelope** stays inside the target's angular width:

- `envelope = recoilCoef² · √currentRecoil` — the radian upper bound of the recoil
  pattern's offset; it grows with every shot.
- `aimWidth(d) = lambda · BODY_RADIUS / (π · d)` — the target's angular half-width
  at range `d`, scaled by `lambda`. With the pattern's `sin()` approximated as
  uniform, **1/lambda is the per-shot hit probability at the cutoff**, so bursts
  are naturally range-dependent: long dumps up close, disciplined taps far away.
- When `envelope > aimWidth(distance)`, `burstDone` latches. It clears when the
  recoil pattern resets (`currentRecoil == 0`, after `recoilDelay` idle ticks).

### 3b. Feasible range — is the shot worth taking?

`gun.feasibleRange` (entities/gun.ts) = the bullet's physical reach,
`bulletSpeed · bulletLife` (a round simply vanishes past it). It gates three
things:

- **Firing:** `shouldFire` refuses a target beyond it (the bullet would die short).
- **Targeting:** out-of-range hostiles are penalised in selection (below).
- **Contact:** "in contact" and the distance-until-contact metrics require being
  *within range*, not merely able to see (below).

*(Named for the concept, not the formula — a later accuracy-aware model slots into
that one getter without touching callers.)*

### 3c. The posture state machine

Two fields: `combatMode` ∈ {shoot, cover} is pure gun-readiness; `mode` ∈ {shoot,
cover, run, heal} is what's actually done this tick (RUN/HEAL override combat).

```
updateMode(ref)   ← readiness → combatMode, most changes reaction-gated
  burstDone latches when envelope > aimWidth (see 3a); clears on recoil reset
  if mag == 0: start a (hardcore) reload
  ready = not burstDone and not reloading
  on ready flipping:  fireOk drops INSTANTLY if not ready (reflex);  the shoot<->cover
                      flip and resuming fire happen reactionTime later
  → combatMode = shoot when ready, cover when not

updatePosture()   ← combatMode + HP + contact distances → mode, and holds the matching item slot
  fightDist  = min(visDist, enemyVisDist)                 ← soonest a fight could start
  runSafe    = fightDist >= RUN_DISTANCE
  healSafe   = hp < HEAL_HP and carrying a heal and enemyVisDist >= HEAL_SAFE_DISTANCE
  (dwell counters: RUN/HEAL commit only after the condition holds RUN/HEAL_COMMIT_TICKS — a
   peeking enemy whipsaws the distance and keeps resetting the dwell, so neither triggers on a blink)

  RELOADING → cover IMMEDIATELY (reflex, bypasses the reaction delay)     ← a self-known, vulnerable moment
  priority:  heal  >  run  >  (reload→cover)  >  combatMode
  applyPostureSlot(): heal→hold the healing item & keep using; run→holster to fists; else→weapon out
```

The four postures:

| mode | when | what it does |
|------|------|--------------|
| **shoot** | ready, enemy in sight & within `engageRange` | hold ground and fire; strafe to a better lane only if the current one is bad (`strafeMove`). Approach over the graph if out of sight / beyond `engageRange`. |
| **cover** | burst spent, **or reloading** | strafe to the spot the opponent sees least of; if nowhere is better *and* here is no cover either, dodge side-to-side (`coverMove`). Re-emerges to shoot once recoil resets & reload's done — an emergent **peek cycle**. |
| **run** | no fight for a while (`fightDist >= RUN_DISTANCE`, dwell met) | holster to fists, sprint (`RUN_SPEED_MUL`) to contact via the graph, re-arm on arrival. Faces straight ahead (no corner pre-aim). |
| **heal** | hurt (`hp < HEAL_HP`), safe (`enemyVisDist >= HEAL_SAFE_DISTANCE`, dwell met), carrying a heal | back away to grow the threat's reach-to-us up to `HEAL_SEEK_DISTANCE`, then hold cover burning heal items back-to-back. Aborts instantly (re-arms) if the enemy could see us within `HEAL_ALARM_DISTANCE`, we top off, or run out. |

RUN/HEAL entry is **committed a-priori** (dwell), exit is **instant** for HEAL
(safety). The `700 > 400` gap between `HEAL_SAFE_DISTANCE` and `HEAL_ALARM_DISTANCE`
is stay-hysteresis so it doesn't chatter.

### 3d. `act()` — the TacOracle decision tree

```
TacOracle.act(ai, target):
  vel = 0
  drop stale focus (dead, or unseen for > FOCUS_MEMORY)
  chase = target ?? focus ?? bestChase(ai)          ← seen enemy, else remembered, else cheapest-to-reach
  contact metrics:
     if in contact with chase (see it AND within our range, same z):  visDist=enemyVisDist=0
     elif chase:  contactScan (cached CONTACT_EVAL_TICKS)             ← nav-scan-heavy; only when out of contact
     else:        both = Infinity
  updateMode(); updatePosture()                     ← may become run/heal (see 3c)
  biasObj = biasObjective(ai)                        ← capture-point pull for combat maneuvering (base: null)
  if no chase: return

  ── STAND-TO-SHOOT HOLD (standToShoot) ──
  if target and mode==shoot and fireOk and not burstDone
     and gun.movePenalty >= STAND_TO_SHOOT_PENALTY (heavy gun)
     and dist(target) <= feasibleRange           ← must actually be able to shoot, else it freezes planted
     and laneClear:
        return           ← plant and fire; repositioning waits for between bursts

  ── MOVEMENT BY MODE ──
  if mode==heal:  healMove(ai, chase)                ← back off / hold cover, keep healing
  elif mode==cover: coverMove(ai, chase)             ← least-exposure spot, or dodge
  elif target and dist<=engageRange: strafeMove(ai,target)  ← in-range fight: hold / slide to a lane
  else:                                              ← approach
        clear a teammate's lane first (blockingMate/sidestep), else navChase
```

Firing itself (`shouldFire`, run every tick):

```
shouldFire(ai, target):
  false unless mode==shoot and fireOk and target present
  false if between semi-auto clicks (clickIn > 0)
  false if dist(target) > feasibleRange                    ← bullet would die short
  false if the muzzle isn't settled on the (jittered) aim within max(aimWidth(d), MIN_AIM_TOLERANCE)
  return laneClear(ai, target)                             ← never fire with a friendly downrange
```

### 3e. Target selection — cost, not distance (`selectTarget`)

Among visible hostiles, lock the one that can be **shot soonest**, not the nearest:

```
selectTarget(ai):
  keep the current focus if still valid and the TARGET_EVAL_TICKS timer hasn't fired
  for each visible hostile h on my z:
      cost = shootCost(ai, h) + BETA_DIST · dist(h)          ← time-to-first-shot, nudged toward closer
      if dist(h) > feasibleRange: cost += OUT_OF_RANGE_PENALTY   ← anyone reachable outranks anyone not
      if h == focus: cost -= FOCUS_STICKINESS               ← don't flip-flop between near-equal targets
  pick the min; remember it as focus (kept while briefly blind)
```

`shootCost(ai, h)` = the *repositioning* distance to the nearest local movement
point (here or a strafe candidate) whose lane onto `h` is clear of friends, plus
`LOW_VIS_PENALTY` if that lane is poor (≤ `LOW_VISIBILITY` points visible). No
lane anywhere → a flat `NO_LANE_COST`, so anyone shootable-in-place beats anyone
who isn't. It is deliberately *not* distance-scaled: range enters the cost only
through the single `BETA_DIST · dist(h)` term above, applied uniformly to
lane-blocked and shootable hostiles alike. (Folding raw distance into the no-lane
branch too used to double-weight it, letting a clear far enemy outrank a merely
teammate-blocked near one — the bot would aim across the map instead of at the
enemy right in front.)

### 3f. Strafe / cover candidates & scoring

`candidates(ai, opponent)` samples movement spots and scores each one's firing
lane. It's the most-profiled routine (`ai.candidates`); the whole cost model rests
on it.

- **Spots:** here (`offset 0`), plus `STRAFE_OFFSETS` to both sides
  perpendicular to the opponent line (same-z firing lanes), plus `AXIAL_OFFSETS`
  fwd/back along the line (which may cross a stair → drop z → pure cover).
- **Score (`scoreAt`)** — one ray per target point: obstacle-blocked `0`, teammate
  in the ray `-1` (never trade a friend for a shot), clear `+1`.
  - `exposed` = rays not blocked by geometry (the opponent's *view* of the spot; a
    teammate is **not** cover).
  - `clear` = rays clear of everything.
  - `score` = firing-lane quality.
- **`strafeMove`** (shoot): if the current lane is good (no friend in it, `clear >
  LOW_VISIBILITY`) → stand and shoot. Else slide to the best-scoring same-z spot.
- **`coverMove`** (cover): go to the **least-`exposed`** spot. If the whole fan is
  equally exposed (open ground / opponent on another level) → dodge on the
  `DODGE_TICKS` rhythm instead of standing flat-footed.

### 3g. Contact metrics — when is a fight on? (`contactScan`)

Two nav-route distances, both z- and range-aware, minimised over the
`CONTACT_SCAN_K` nearest hostiles (the rest can't be the soonest threat), cached
`CONTACT_EVAL_TICKS`:

- **`visDist`** = *our* distance-until-contact: how far WE must travel to both see
  a hostile **and** be within our weapon's range of it (`routeUntilSight` with our
  `feasibleRange`). Drives RUN.
- **`enemyVisDist`** = the *enemy's* distance-until-contact to US, using **their**
  gun's range — the soonest ANYONE could see-and-reach us. Drives HEAL, and the
  `threat` it retreats from. It stays long while we're tucked in cover (whereas
  `visDist` snaps to 0 the instant they peek a lane we can see), which is why heal
  keys off it.

`routeUntilSight` returns 0 if already see-and-in-range; if visible but out of
range, the straight gap left to close; if not visible, the route to the nearest
sighting node plus any residual gap. It's the old sight-only scan plus `dist()`
arithmetic — no new raycasts, so it stays cheap.

### 3h. Crowd spacing

There is **no boids/separation steering** in the AI (an earlier layered approach
fought the movement and was removed). Spacing comes from two places instead:

- **`separateCharacters` (game.ts):** a single small "squishy" push per tick on
  touching bodies. Soft — bodies driven together harder than the push clip
  through, so nothing wedges permanently.
- **`blockingMate` / `sidestep` (during approach):** if a teammate is in our
  travel/aim lane ahead (within `CROWD_DIST`, `CROWD_MARGIN` of the line), veer
  around them so we don't march in behind (and flag) them. If boxed in, drive
  straight and let squishy collision phase us through rather than freeze.

---

## Layer 4 — `DominationOracle`: playing the objective

A thin override: fight identically, but when **no enemy is in its sights**, work
the capture points instead of hunting the nearest hostile. Only the out-of-combat
destination and a combat bias change.

```
bestChase(ai):   ← consulted only when nothing is seen (selectTarget engages visible enemies first, for free)
  best = nearest capture point we don't already own at full strength (progress<2)
  if none: super.bestChase (own everything → hunt/defend the nearest enemy)
  contester = nearest hostile within (radius + CONTEST_PAD) of that point
  if contester: return it            ← enemies on/around the point contest it → hunt them like a TacOracle
  else: park a throwaway marker on captureSpot(point) and chase THAT   ← walk onto the point to capture it
```

- **`captureSpot`** snaps the marker to the nearest nav node on the point's level.
  A point's exact centre can sit in a wall with no node that sees or walks to it
  (a stranding freeze); a real graph node always has a route, and standing there is
  inside the radius so it still captures.
- **`inContact` override:** the marker is never treated as a live enemy — otherwise
  it would zero the contact metrics and stop the bot healing / running on the way
  there. Real enemies go through the (now range-aware) base `inContact`.
- **`standoffFor` override:** `0` for the marker, so it walks right onto the point
  instead of stopping a gun-length short and hovering off it.
- **`biasObjective` override:** when fighting within `radius + OBJ_PULL_MARGIN` of
  a workable point, `strafeMove`/`coverMove` bias their spot choice toward the
  point (`objReward`: a huge flat bonus for standing on it — `ON_POINT_REWARD` —
  else nearer-is-better), among spots that can *still* shoot/cover. So a firefight
  near a point is waged FROM the point (capturing while shooting) instead of drifting
  off it.

---

## Tunables reference

Combat feel lives in these constants. All ticks are 60/s; all distances world px.

**Robot** (`robot.ts`)
| const | val | meaning |
|-------|-----|---------|
| `TURN_GAIN` / `TURN_FLOOR_DEG` | 0.05 / 2° | aim easing: step = angle·gain + floor |
| `WANDER_MIN`/`MAX` | 60 / 180 | idle turn interval |
| `AIM_RESAMPLE_TICKS` | 20 | how often aim jitter is re-drawn |
| `BODY_RADIUS` (character.ts) | 30 | body radius; 5 sample points per target |

**Oracle** (`oracle.ts`)
| const | val | meaning |
|-------|-----|---------|
| `DEFAULT_MOVE_SPEED` | 2.4 | walk speed |
| `DEFAULT_STANDOFF` | 130 | beeline stop distance |
| `ARRIVE_EPS` | 8 | "at the waypoint" slop |
| `REPLAN_TICKS` | 30 | path re-query cadence |
| `SWITCH_MARGIN` | 80 | sticky-hop switch threshold |
| `MAX_SKIP` | 4 | string-pull hops/tick |
| `AIM_HOLD_TICKS` | 45 | hold last combat aim after losing sight |
| `FACE_NEXT_DISTANCE` | 650 | corner pre-aim lookahead |

**TacOracle** (`tacoracle.ts`)
| const | val | meaning |
|-------|-----|---------|
| `DEFAULT_LAMBDA` | 5 | burst aim budget; ~1/λ hit odds at cutoff |
| `STAND_TO_SHOOT_PENALTY` | 2.0 | movePenalty ≥ this → fire from a stand |
| `MIN_AIM_TOLERANCE` | 15° | trigger aim-settle floor |
| `DEFAULT_REACTION_TIME` | 15 | reaction gate |
| `DEFAULT_STAGGER` | 5 | plan cadence (phase-offset per bot) |
| `DEFAULT_SEMI_AUTO_DELAY` | 5 | extra per-click delay, semi-auto |
| `DEFAULT_ENGAGE_RANGE` | 600 | stop closing, stand & fight within this |
| `LOW_VISIBILITY` | 2 | ≤ this target points visible = a poor lane |
| `STRAFE_OFFSETS` | 15…120 | lateral candidate spots |
| `AXIAL_OFFSETS` | 40, 90 | fwd/back cover spots |
| `BETA_DIST` | 0.35 | distance weight in target selection |
| `OUT_OF_RANGE_PENALTY` | 1e5 | out-of-feasible-range targeting penalty |
| `NO_LANE_COST` / `LOW_VIS_PENALTY` | 400 / 60 | shootCost surcharges |
| `FOCUS_STICKINESS` / `FOCUS_MEMORY` | 30 / 120 | anti flip-flop / blind memory |
| `EVAL_TICKS` / `TARGET_EVAL_TICKS` / `CHASE_EVAL_TICKS` | 10 / 10 / 30 | re-eval cadences |
| `DODGE_TICKS` | 30 | dodge flip rhythm |
| `FRIENDLY_MARGIN` | 60 | friendly-fire lane half-width |
| `CROWD_DIST` / `CROWD_MARGIN` | 180 / 60 | anti-flag veer trigger |
| `RUN_SPEED_MUL` / `RUN_DISTANCE` / `RUN_COMMIT_TICKS` | 1.4 / 1000 / 90 | sprint speed / trigger / dwell |
| `HEAL_HP` | 75 | heal-seeking HP threshold |
| `HEAL_SAFE` / `_SEEK` / `_ALARM` _DISTANCE | 700 / 1200 / 400 | heal enter / back-off-to / abort |
| `HEAL_COMMIT_TICKS` | 90 | heal entry dwell |
| `CONTACT_SCAN_K` / `CONTACT_EVAL_TICKS` | 3 / 15 | contact-scan breadth / cadence |

**DominationOracle** (`domoracle.ts`)
| const | val | meaning |
|-------|-----|---------|
| `CONTEST_PAD` | 120 (4·body) | enemy-contests-point radius pad |
| `OBJ_PULL_MARGIN` | 300 (10·body) | combat-bias-toward-point trigger |

---

## Reading order for the code

1. `robot.ts` — the tick pipeline, sight, reaction. Start here.
2. `oracle.ts` — navigation. `navChase` → `updatePlan` → `plan`.
3. `tacoracle.ts` — the soldier. `act` is the spine; then `updateMode`/`updatePosture`,
   `shouldFire`, `selectTarget`/`shootCost`, `candidates`/`scoreAt`, `contactScan`.
4. `domoracle.ts` — the objective overrides.

Supporting cast: `world/nav.ts` (the graph & `route`/`walkable`/`nearestInSight`),
`entities/gun.ts` (`feasibleRange`, recoil pattern), `entities/team.ts` (`hostiles`).
