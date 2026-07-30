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

Everything below a layer is inherited unchanged unless noted. A level spec or a
gamemode picks which class to spawn and with what options (`RobotOptions` →
`OracleOptions` → `TacOracleOptions`) — see "Who spawns which class" below, since
the two paths don't expose the same knobs.

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
  3. applyStairMove()      ← if the step just taken was on a staircase, shrink its climb-axis
                             component (and pull pos back to match). No-op off stairs.
  4. AIM (every tick)
       target = lastTarget if still alive else null
       if target: aimAngle = angle to (target.pos + aimError)     ← jittered point, not the true target
       angle = turnToward(angle, aimAngle)                        ← eased, never snaps (TURN_GAIN 0.05 + 2° floor)
       forward = fromAngle(angle)
  5. FIRE (every tick)
       if shouldFire(ai, target) and gun.fire(world): onFired()
```

Robots step `pos` directly (kinematic) and only *report* the step in `vel` — so
anything reading `speed` (the real gun's movement accuracy penalty, above all)
sees graph-walking and strafing as real movement. Stairs are the one exception:
`applyStairMove` slows the climb, but the `speed` getter divides that slowdown
back out, so climbing is slower without also being *less accurate* than walking.

`decide()` picks the *desired* heading and the movement for this plan; the actual
heading eases toward it every tick, and the trigger is pulled every tick it's
allowed. `lastTarget` is the bridge: `decide` sets it, the between-plan ticks aim
and fire at it.

### Where this sits in the game tick (`game.ts`)

Order matters for a few behaviours, so: every character's `onStairs` is refreshed
→ the player moves → vehicles integrate & re-weight the nav graph → `tickWeapon`
(cooldowns, recoil decay) → `tickStatus` (heal-use timer, regen) → the player
fires → **every live Robot's `think`** → stair-z flips + wall collision + body
separation → bullets resolve → dead reaped, gamemode rules.

Two consequences worth remembering: an AI plans against **last tick's** resolved
positions but this tick's recoil state; and the movement it commits is only
*proposed* — walls and the body-separation pass get the last word after `think`
returns, so a bot can end the tick somewhere its own plan didn't put it.

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
(`world/nav.ts`: a Customizable Contraction Hierarchy; `route(from,to)` → next
hop + total distance via a bidirectional up-search — exact, and re-weightable in
place when a car/crate changes the map without rebuilding the whole index). It
still aims/fires like a Robot.

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
| **hold** | nothing in sight, contact nearer than `RUN_DISTANCE`, dwell met, and cover exists (`wantsHold` + a successful `planHold`). DominationOracle instead: standing on any site with no enemy on it | dig in on the spot an approaching enemy must walk into, gun already pointed at it, and wait. See 3d-hold. |

RUN/HEAL/HOLD entry is **committed a-priori** (dwell), exit is **instant** for
HEAL (safety).

`runDwell` is held at **0 for the whole of a HOLD**. RUN and HOLD move in
opposite directions, so without that a HOLD ending hands straight over to a RUN
whose "a-priori commitment" filled up while the bot was dug in — the dwell gated
nothing between them, and the pair ping-ponged: run in, dig in, walk back to
cover, run in again. Leaving HOLD now drops to combat and RUN re-earns its 90
ticks.

This is deliberately **not** mirrored on `holdDwell`, which keeps charging during
a RUN. RUN has no completion condition of its own — arriving somewhere doesn't
change `fightDist` — so a bot that reaches its destination just stands there
holstered, and HOLD taking over is what ends it. Blocking that deadlocks RUN.

HOLD also only commits once `tryPlanHold` proves a plan exists, so the posture is
never entered and then abandoned for want of cover. The `700 > 400` gap between `HEAL_SAFE_DISTANCE` and
`HEAL_ALARM_DISTANCE` is stay-hysteresis so it doesn't chatter.

Priority is `heal > hold > run > (reload→cover) > combatMode`. HOLD sits above
RUN so an objective-holder doesn't sprint off the thing it's guarding; for a
plain TacOracle the two can't both apply anyway (HOLD wants contact *nearer* than
`RUN_DISTANCE`, RUN wants it further). HOLD also bypasses the reload→cover
reflex, because it does its own ducking (below).

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
  elif mode==hold: holdMove(ai, nearestHostile)      ← dig in on the pre-aimed angle (3d-hold)
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

### 3d-hold. HOLD — defending an angle (`planHold`)

The other postures react to where the enemy *is*. HOLD reasons about where they
will have to *come from*, picks the ground that beats them there, and waits with
the gun already up. The plan is three steps, each depending on the last, and it
is **frozen while the bot is moving and refreshed only once it's planted** — the
entry point is derived from the enemy's route to where we *stand*, so refreshing
it mid-walk would chase its own tail: the plan moves us, which moves the plan
(the same oscillation `SWITCH_MARGIN` exists to stop). Standing still, that loop
can't close, so a refresh there is safe.

```
  0. THREAT (holdThreat)
       the hostile who could ENGAGE us soonest: their distance-until-visibility
       (routeUntilSight from their side, with their drawn weapon's reach — the
       same quantity contactScan calls enemyMin), minimised over EVERY hostile.
planHold(ai, threat):
  1. ENTRY POINT
       walk the route from THEIR node toward ours (route() hop by hop, ≤ HOLD_PATH_HOPS)
       entryNode = the first node on it we could SHOOT (clear geometry AND no
               teammate in the line — shootingLaneClear)
       then REFINE: march the leg from the node before it (or from the enemy
               themselves, if the visible node is where they already stand) in
               HOLD_ENTRY_STEP increments and take the first point in view
                                                       ← where they step into view
  2. COVERED POINT
       Dijkstra outward from OUR node over `movable` links, in distance order
       covered = the first settled node with NO clear line to the entry point
                 (the baked `visible` set as a free reject, confirmed with one
                 live losClear), that passes holdSpotOk and is not already taken
                 by a teammate — standing there OR committed to it (mateHolding)
  3. PEEK SPOT
       scan the final leg IN — from the PREDECESSOR toward `covered`, in
       HOLD_PEEK_STEP increments — and keep the last step whose line to the
       entry point is still clear; then relax HOLD_PEEK_MARGIN back outward.
       Cover that yields no such spot is REJECTED and the search continues.
       The committed route ENDS at the peek: the cover is a duck destination,
       not somewhere the bot walks to and then backs out of.
```

**Why that metric and not walk distance.** A hold is choosing an angle to watch,
so the ordering that matters is who gets eyes and reach on us first — a sniper
down a long sightline is more urgent than someone closer behind three walls, and
walking distance ranks those backwards. Switching from walk distance to
distance-until-visibility cut the damage taken while dug in by roughly 11x on
dom-arena-big and 2.6x on tdm-arena-big, while holds also lasted longer.

It deliberately does **not** reuse contactScan's cached `threat`, which computes
the same quantity: that pre-filters to the `CONTACT_SCAN_K` nearest hostiles *by
straight line* before routing any of them, and on a multi-storey map that throws
away the genuinely closest enemy before it is ever costed — which is how bots
ended up digging in against whoever happened to be standing directly overhead.
`holdThreat` scans every hostile. The approximation is in the distance
(route-to-nearest-sighting-node plus any residual gap), not in which enemies are
considered.

Scanning inward rather than outward matters twice over. `from` always sees the
entry — the predecessor was rejected *for* being visible, and when the cover is
our own node our position had to see the entry for it to be chosen at all — so
the scan is guaranteed to start seeing and end blind, where the reverse direction
could fail to find anything. And it can only return a spot **contiguously**
visible from the side the bot approaches on, rather than one that happens to see
past a blind stretch. It shows up in the numbers: failed plans roughly halved
(33 -> 13 on tdm-arena-big, 49 -> 21 on dom-arena-big) when the scan was turned
around.

**The refinement is the difference between aiming at a corner and aiming at a
node.** An enemy does not appear AT the first visible node — they come round the
corner somewhere on the leg before it, so a bot aimed at the node is aimed late by
up to a full hop. Marching that leg moves the aim point earlier in **79%** of
cases, by a mean of **105 px** (max 325, against a 350 px `MOVE_RADIUS` ceiling).
It costs one raycast per step, which is why it's affordable at all.

The *node* is still kept alongside the refined position as the plan's identity:
the position shifts continuously as the enemy moves, so a refresh comparing
positions would rebuild every second, where comparing nodes rebuilds only on a
real change of approach. The cost of the change is that the baked node `visible`
set can no longer pre-reject cover candidates (the entry is a point on a leg now,
not a node), so step 2 pays one live ray per settled candidate instead.

**Teammates count as blockers for the angle, never for the cover.** Steps 1 and 3
ask "could we shoot down this line", so `shootingLaneClear` adds the same
friendly-lane test the trigger uses (`friendInLine` / `FRIENDLY_MARGIN`) on top of
the geometry — otherwise a bot digs in watching a door one of its own squad is
stood in front of, and holds fire the moment anyone appears. Step 2 asks the
opposite question and stays pure `losClear`: a body is not cover, the same rule
`scoreAt` applies when it counts `exposed`. With a teammate parked mid-lane, 55 of
60 test cases moved to a different entry point and none refused to plan, so the
angle shifts rather than the hold being lost.

Teammates move and the plan is frozen between refreshes, so a mate wandering
through at plan time can bias the angle for up to `HOLD_REPLAN_TICKS`. That's the
same tradeoff `mateHolding` makes, and much cheaper than re-planning whenever
someone walks past.

Two things make step 3 work:

- **The predecessor is guaranteed to be more exposed than cover.** The search
  settles nodes in increasing distance, so every node reached before `covered` —
  its shortest-path predecessor included — was *rejected*, and the only way to be
  rejected is to be visible from the entry point. So "toward the predecessor" is
  always a direction in which exposure increases. (Standing already-covered there
  is no predecessor, so it leans toward the entry point itself instead.)
- **Every visibility test in HOLD is centre-to-centre** (`losClear(spot, entry)`),
  because the bot's centre is the eye every sight and firing check rays from.
  Cover means that line is blocked, the peek means it is clear. The baked node
  `visible` sets are the same centre-to-centre relation, so step 2 takes a free
  reject from them and confirms with one live ray — which also catches vehicles,
  which the baked sets don't know about.

Once planned, HOLD walks the committed node route (`followHold`) and then sits.
While the gun is out of action — reloading, or the burst is spent — it retreats
to `holdCover` (fully hidden) and slides back out to `holdPeek` when ready: the
same peek cycle COVER has, but rehearsed against a doorway instead of reacting to
a body. **Facing is owned outright** (`faceHold`) for the whole posture, including
while still walking to cover — otherwise the approach's blind lookahead would
point the gun down the travel direction, and a pre-aimed angle is the entire
point of the feature.

A failed plan (no route, no cover in range, nothing satisfying `holdSpotOk`)
parks the posture for `HOLD_RETRY_TICKS` rather than re-running the search
against geometry that won't have changed.

**The parked refresh** (`refreshHold`, every `HOLD_REPLAN_TICKS` — ~1s — while
parked at either end of the cover<->peek slide) re-runs steps 0 and 1 only. The
countdown advances by `stagger`, not 1, because `holdMove` runs on plan ticks
only: a raw decrement made the period `stagger` times longer than it read, which
is what made holds look like they planned once and never re-evaluated. If the nearest enemy would still enter view at the
same node, *nothing happens at all* — so a timer can never jitter a settled
soldier between two equally good spots. A genuinely different approach rebuilds
steps 2–3 around it; a rebuild that finds no cover for the new angle leaves the
old plan untouched rather than trading working cover for none.

`mateHolding` exists because one node fits one body: without it two soldiers
covering the same corridor both pick the same best node, and then spend the fight
shoving each other off it — the squishy body separation pushes them apart and
both walk straight back. A spot counts as taken when a teammate is **standing on
it or has committed to it** (their `holdCover` or `holdPeek`), because the walk
there takes a second and a body-position test can't see a claim in transit: with
only the body test, two bots claimed the same node on ~60% of the ticks where
more than one was dug in. Claims release when `clearHold` ends the posture. It's
the only crowd rule inside HOLD; general spacing is still `separateCharacters`' job.

**There is currently no exit timer.** A bot holds as long as `wantsHold` stays
true — that is, until something comes into view (it fights) or contact drifts
past `RUN_DISTANCE` (it runs). On a map where neither happens, two dug-in teams
will stare at each other; a jittered hold duration is the intended fix when that
becomes a problem.

### 3e. `coast()` — the 4 ticks out of 5 that aren't planning

With the default `stagger: 5`, `act()` runs on one tick in five; the other four
run `TacOracle.coast`, and it is **not** a no-op. Behaviour that looks like it
comes from `act` often actually comes from here:

```
coast(ai):
  updateMode(target ?? focus)     ← burst envelope, reload start, click timer — EVERY tick
  updatePosture()                 ← so heal items keep chaining and the held slot stays right
  if mode==heal:  step to the committed strafeTarget (or hold) and return   ← never coast at the enemy
  if mode==hold:  followHold + faceHold and return   ← keeps walking/aiming, never re-plans
  if standToShoot(...): return                                              ← mirrors act's plant
  if strafeTarget: step toward it; return                                   ← finish the committed slide
  else: sidestep around a blocking mate, else coastStep (one more hop, no path query)
```

So: gun bookkeeping and posture are **per-tick**; target choice, candidate
scoring, and path queries are **per-plan-tick**. If a bot reacts to its own mag
running dry instantly but takes ~5 ticks to notice you moved, that split is why.

### 3f. Target selection — cost, not distance (`selectTarget`)

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

Because `BETA_DIST` is `0.75` and `NO_LANE_COST` is `400`, the practical trade is:
**a shootable hostile beats a lane-blocked one even when it's ~300–530 px further
away** (the span is how much strafing the shootable one costs, 0–180). Raise
`BETA_DIST` and bots fixate on whoever's closest even
through a teammate; lower it and they'll turn to snipe someone far away because
the lane happens to be cleaner. The stale `0.35` in `shootCost`'s comment is the
old value, not the live one.

### 3g. Strafe / cover candidates & scoring

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

### 3h. Contact metrics — when is a fight on? (`contactScan`)

Two nav-route distances, both z- and range-aware, minimised over the
`CONTACT_SCAN_K` nearest hostiles (the rest can't be the soonest threat), cached
`CONTACT_EVAL_TICKS`:

- **`visDist`** = *our* distance-until-contact: how far WE must travel to both see
  a hostile **and** be within weapon range of it. Drives RUN.

  The range used is `fightingRange` — the gun we would **draw** (primary, else
  secondary), not the one in our hands. RUN holsters to the fists, and measuring
  with those (~138 px of punching reach) told a sprinting bot it was not in
  contact until it could touch the enemy: its own metric stayed enormous the whole
  way in, so only the *enemy's* reach-to-us ever ended the sprint, and the bot
  re-armed on seeing someone rather than on a fight becoming imminent. That was
  the "runners get ambushed" bug — hits taken while holstered dropped from 5.3% to
  1.1% on dom-arena-big when the metric started using the drawn weapon.
- **`enemyVisDist`** = the *enemy's* distance-until-contact to US, using **their**
  `fightingRange` (same reasoning mirrored — a hostile sprinting at us with its
  weapon holstered is not a punching-only threat) — the soonest ANYONE could see-and-reach us. Drives HEAL, and the
  `threat` it retreats from. It stays long while we're tucked in cover (whereas
  `visDist` snaps to 0 the instant they peek a lane we can see), which is why heal
  keys off it.

`routeUntilSight` returns 0 if already see-and-in-range; if visible but out of
range, the straight gap left to close; if not visible, the route to the nearest
sighting node plus any residual gap. It's the old sight-only scan plus `dist()`
arithmetic — no new raycasts, so it stays cheap.

### 3i. Crowd spacing

There is **no boids/separation steering** in the AI (an earlier layered approach
fought the movement and was removed). Spacing comes from two places instead:

- **`separateCharacters` (game.ts):** a single small "squishy" push per tick on
  touching bodies. Soft — bodies driven together harder than the push clip
  through, so nothing wedges permanently.
- **`blockingMate` / `sidestep` (during approach):** if a teammate is in our
  travel/aim lane ahead (within `CROWD_DIST`, `CROWD_MARGIN` of the line), veer
  around them so we don't march in behind (and flag) them. If boxed in, drive
  straight and let squishy collision phase us through rather than freeze.

### 3j. Vehicles

**No AI drives.** Only the player can take a seat (`game.ts enterVehicle`); bots
have no entry, exit, or driving logic at all, and they don't treat an occupied
car as anything but a wall with a person somewhere inside it. Vehicles still
reach the AI in two places, both indirect:

- **Sight:** `losClear` fails if a vehicle hull crosses the ray on that z, so a
  parked car is real cover — it drops `visibility`, kills firing lanes, and feeds
  straight into `scoreAt` / `shootCost` / the contact scans.
- **Movement:** `walkable`'s march tests hulls too, so vehicles block nav edges,
  and `Vehicle.drive` re-customizes the CCH each tick for the edges near it. A
  car pulling away *un*-blocks those edges within a tick — no rebuild — so bots
  re-route through a newly cleared alley on their next plan tick.

A seated player is still a normal target (they're a `Character` pinned to the
seat), so bots will happily shoot at a driver whose hull isn't in the way.

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
- **`wantsHold` override:** dig in whenever it's standing on a site with nothing
  in sight and **no hostile on the site** (out to `radius + CONTEST_PAD`). The
  site is **latched on entry** and re-resolved by position each tick (the gamemode
  rebuilds the objective objects every frame), so walking to cover a step outside
  the ring doesn't drop the posture — re-testing "am I inside a ring" every tick
  was half of the run<->hold bounce.
  Ownership is irrelevant — an uncaptured site keeps ticking over while the bot
  stands in it, and `holdSpotOk` pins the spot inside the ring until it's ours and
  reinforced, so digging in captures and defends in one motion. An enemy on the
  site is the single exclusion: that's a contest to be fought, not a vigil to be
  kept. Unlike the base soldier this ignores how far off contact is (a site is
  worth holding regardless), and since HOLD outranks RUN it won't sprint away.
- **`holdSpotOk` override:** **never take cover off the point.** A covered spot
  outside the ring stops the capture, which is the whole reason it's standing
  there — so hold candidates (both the covered node and every peek step) are
  constrained to inside the radius. Once the point is ours *and* fully reinforced
  (`progress >= 2`) there's no progress left to lose, so real cover anywhere is
  allowed again.
- **`biasObjective` override:** when fighting within `radius + OBJ_PULL_MARGIN` of
  a workable point, `strafeMove`/`coverMove` bias their spot choice toward the
  point (`objReward`: a huge flat bonus for standing on it — `ON_POINT_REWARD` —
  else nearer-is-better), among spots that can *still* shoot/cover. So a firefight
  near a point is waged FROM the point (capturing while shooting) instead of drifting
  off it.

---

## Who spawns which class (`enemies.ts`)

Two entirely separate paths build bots, and they don't offer the same options —
worth knowing before you wonder why an editor-placed bot behaves differently from
a match bot with "the same" settings.

- **Authored spawns** (`spawnEnemy`, from a level's `EnemySpawn`): picks from the
  `ENEMY_TYPES` palette — `robot`, `elite` (200 HP, tighter spread), `oracle`,
  `tacoracle`. Per-spawn fields are position/z/gun/armor/team/skin only. **These
  get the class defaults for `reactionTime`, `lambda`, `aimSigma`, `stagger`** —
  there is no editor knob for them, and `DominationOracle` isn't in the palette at
  all.
- **Gamemode troops** (`makeTroop`, used by TDM/teammatch/domination): passes the
  fine knobs, and chooses `TacOracle` vs `DominationOracle` via `ai:`. This is the
  only way to get an objective-playing bot.

`skillParams(skill)` (teammatch.ts) is where a single `skill` scalar in [0,1]
becomes bot behaviour — the one dial that explains most "why is this bot good/bad"
questions:

| skill → | 0 (worst) | 1 (best) | effect |
|---|---|---|---|
| `reactionTime` | 30 ticks (~500 ms) | 3 ticks (~50 ms) | how long you must stay visible before it engages, and how late it notices its own readiness changes |
| `lambda` | 2.5 | 8.0 | burst length / bravery (`~1/lambda` hit odds at the cutoff) |
| `aimSigma` | 48 px | 6 px | Gaussian aim wobble — dominant up close, negligible far |
| `strafeOffsets` | last 2 of the fan (90, 120) | all 6 (15…120) | lane exploration: a low-skill bot only knows how to take *big* sidesteps |

Note the `strafeOffsets` slice takes from the **end** of the fan, so low skill
means coarse, large strafes — not "stands still". Everything else (engage range,
run/heal thresholds, cover logic) is identical at every skill.

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
| `BETA_DIST` | 0.75 | distance weight in target selection |
| `OUT_OF_RANGE_PENALTY` | 1e5 | out-of-feasible-range targeting penalty |
| `NO_LANE_COST` / `LOW_VIS_PENALTY` | 400 / 60 | shootCost surcharges |
| `FOCUS_STICKINESS` / `FOCUS_MEMORY` | 30 / 120 | anti flip-flop / blind memory |
| `EVAL_TICKS` / `TARGET_EVAL_TICKS` / `CHASE_EVAL_TICKS` | 10 / 10 / 30 | re-eval cadences (candidate spots / target lock / blind chase) |
| `ARRIVE` | 2 | "reached the strafe spot" slop |
| `ON_POINT_REWARD` | 1e6 | flat bonus for a combat spot on the capture point |
| `DODGE_TICKS` | 30 | dodge flip rhythm |
| `FRIENDLY_MARGIN` | 60 | friendly-fire lane half-width |
| `CROWD_DIST` / `CROWD_MARGIN` | 180 / 60 | anti-flag veer trigger |
| `RUN_SPEED_MUL` / `RUN_DISTANCE` / `RUN_COMMIT_TICKS` | 1.4 / 1000 / 90 | sprint speed / trigger / dwell |
| `HEAL_HP` | 75 | heal-seeking HP threshold |
| `HEAL_SAFE` / `_SEEK` / `_ALARM` _DISTANCE | 700 / 1200 / 400 | heal enter / back-off-to / abort |
| `HEAL_COMMIT_TICKS` | 90 | heal entry dwell |
| `CONTACT_SCAN_K` / `CONTACT_EVAL_TICKS` | 3 / 15 | contact-scan breadth / cadence |
| `HOLD_COVER_DISTANCE` | 500 | how far the covered-node search may wander |
| `HOLD_SEARCH_NODES` | 48 | nodes the search may settle before giving up |
| `HOLD_PATH_HOPS` | 24 | hops of the enemy's route walked for the entry point |
| `HOLD_PEEK_STEP` / `HOLD_ARRIVE` | 8 / 8 | peek slide granularity / hold waypoint slop |
| `HOLD_ENTRY_STEP` | 10 | march granularity refining the entry point |
| `HOLD_PEEK_MARGIN` | 16 | extra lean past where the sight line first opens |
| `HOLD_COMMIT_TICKS` / `HOLD_RETRY_TICKS` | 30 / 60 | hold entry dwell / backoff after a failed plan |
| `HOLD_REPLAN_TICKS` | 60 | parked threat/entry refresh, ~1s (never fires mid-walk) |

Also in `tacoracle.ts`, not constants but easy to miss: `retreatSpot` probes a
fixed `LOOK = 90` px in 5 directions (away, two 30-ish° diagonals, both pure
laterals) and prefers the first that **breaks the threat's line of sight**, else
the first merely walkable one; `lookahead` (oracle.ts) walks at most `MAX_HOPS = 5`
edges.

**DominationOracle** (`domoracle.ts`)
| const | val | meaning |
|-------|-----|---------|
| `CONTEST_PAD` | 120 (4·body) | enemy-contests-point radius pad |
| `OBJ_PULL_MARGIN` | 300 (10·body) | combat-bias-toward-point trigger |

---

## The player is just another character

Worth stating plainly, because it's easy to assume otherwise: the player sits in
`game.characters` like everyone else, so **every AI query that scans characters
includes them** — `hostiles()`, `teammates()`, `mateHolding`, `shootingLaneClear`,
`separateCharacters`. A HOLD will pick the player as its threat and derive its
entry point from the player's route to it, exactly as it would for a bot; there is
no player branch anywhere in the posture code.

The one place the player genuinely *couldn't* be symmetric is the nav congestion
field (`nav.setRoute`). A bot publishes a route because it has a plan with a goal;
the player never states a destination. So `Game.updatePlayerRoute` infers one from
the outside — start at the node they're standing on, follow the graph in the
direction they're actually moving for a few hops — and publishes that. Standing
still, entering a vehicle, or dying withdraws the claim. Bots then route around
the player's corridor the same way they route around each other.

Note the congestion field is **team-agnostic**: an enemy avoids a friendly
corridor just as a teammate does. That falls out of there being one shared
metric, and it's a deliberate simplification, not an oversight — making it
team-aware means one metric per team.

## Symptom → where to look

Behaviour you see, and the specific decision that produces it.

| What it looks like | Most likely cause |
|---|---|
| Bot stands still with the gun up and won't close | `standToShoot` — heavy gun (`movePenalty ≥ 2`) mid-burst, lane clear, target in `feasibleRange`. It plants until the burst ends. |
| Bot freezes staring at a far enemy | The `feasibleRange` gate in `standToShoot`/`shouldFire` failing *while* something else holds it — check `mode`, `fireOk`, `burstDone`. |
| Bot won't shoot a target it's clearly facing | `laneClear` (a teammate within `FRIENDLY_MARGIN` downrange), the aim-settle gate, or `clickIn` on a semi-auto. |
| Bot aims at someone across the map instead of the enemy in front | Target selection: the near one is lane-blocked (`NO_LANE_COST`) — see the `BETA_DIST` trade in 3f. |
| Bot keeps swapping targets | `FOCUS_STICKINESS` too small vs the cost gap, or `TARGET_EVAL_TICKS` firing on a genuinely tied board. |
| Bot backpedals mid-fight for no reason | HEAL entry: `hp < 75`, carrying an item, and `enemyVisDist ≥ 700` held for 90 ticks. Note it keys off the **enemy's** reach, not sight. |
| Bot holsters and sprints past a live enemy | RUN: `min(visDist, enemyVisDist) ≥ 1000` for 90 ticks. If the enemy is in cover, `enemyVisDist` can stay long even when they're near. |
| Bot bobs side to side in the open | `coverMove`'s dodge branch — every candidate equally `exposed`, so there's nothing to hide behind. |
| Bot walks to a corner and just stops, aimed at nothing | HOLD, working as designed — it's aimed at `holdEntry`, the spot an approaching enemy would appear. |
| Bot holds a spot it can't see the entry point from | Shouldn't happen now: the peek needs a clear centre-to-centre line, and cover that can't offer one is rejected. If it recurs, weigh `HOLD_PEEK_MARGIN` against how far a body-separation shove moves it. |
| Bot holds an angle nobody is coming from | The refresh runs ~1s while parked, but no-ops when the recomputed entry node is unchanged (anti-jitter). It re-evaluates far more often than it visibly moves — the knob is that equality check in `refreshHold`, not `HOLD_REPLAN_TICKS`. |
| Bot refuses to hold anywhere on a map | `planHold` failing — no nav route to the threat, or nothing within `HOLD_COVER_DISTANCE` that hides all 5 body points. Check node density. |
| Dom bot stands in the open on a point instead of using nearby cover | `holdSpotOk` — cover off the ring would stop the capture, so it's refused until the point is owned and reinforced. |
| Dom bot won't dig in on a point it's standing on | A hostile is inside `radius + CONTEST_PAD` (a contested site is a fight, not a vigil), or `planHold` found no cover satisfying the on-ring `holdSpotOk`. |
| Whole team digs in and the match stalls | No hold exit timer yet; bots hold until they see someone or contact drifts past `RUN_DISTANCE`. |
| Bot runs in, digs in, walks back, runs in again | Was the run<->hold ping-pong: `runDwell` stayed charged through the HOLD, plus HOLD committing before knowing it had cover, plus the dom site being re-tested by position every tick. All three fixed. |
| Bot stands still in RUN, weapon holstered | RUN ends only when something else takes over; on arrival that's HOLD. If it persists, `holdDwell` is being blocked from charging during RUN. |
| Runner gets shot before drawing its weapon | The contact metrics must use `fightingRange` (the gun it would draw), not `gun.feasibleRange` (the fists it holsters to while sprinting). |
| Bot peeks out, shoots, ducks back, repeats | Working as designed: the burst/cover cycle. `lambda` controls how long each peek's burst lasts. |
| Bot walks a weird dogleg instead of straight | Sticky hop (`SWITCH_MARGIN`) holding a committed waypoint, or the graph genuinely has no direct link (check `MOVE_RADIUS` node spacing). |
| Bot oscillates at a doorway / stair | The anti-flicker rules are being defeated — check `atGoalNode`, and that the direct-step stair guard is firing. |
| Bot walks into a wall near stairs | `plan`'s fallback to `curr` when the next hop isn't straight-walkable. |
| Bot ignores a capture point it's standing next to | `bestChase` only runs when **nothing is visible**; a seen enemy always wins. For combat *on* the point, that's `biasObjective` + `OBJ_PULL_MARGIN`. |
| Bots bunch up / shove each other | `separateCharacters` is deliberately squishy — there is no separation steering. Spacing during approach is only `blockingMate`/`sidestep`. |
| Bot reacts sluggishly to everything | `reactionTime` (skill), compounded by `stagger` — target changes are only seen on plan ticks. |
| Bot misses badly at point-blank range | `aimSigma` is a fixed *world-px* offset, so its angular error grows as range shrinks. Low skill = 48 px of it. |

## Reading order for the code

1. `robot.ts` — the tick pipeline, sight, reaction. Start here.
2. `oracle.ts` — navigation. `navChase` → `updatePlan` → `plan`.
3. `tacoracle.ts` — the soldier. `act` is the spine; then `updateMode`/`updatePosture`,
   `shouldFire`, `selectTarget`/`shootCost`, `candidates`/`scoreAt`, `contactScan`.
4. `domoracle.ts` — the objective overrides.

5. `enemies.ts` — which class each spawn path builds, and with what options.

Supporting cast: `world/nav.ts` (the graph & `route`/`walkable`/`nearestInSight`),
`entities/gun.ts` (`feasibleRange`, recoil pattern), `entities/team.ts` (`hostiles`),
`gamemodes/teammatch.ts` (`skillParams`), `game.ts` (tick order, `separateCharacters`).
