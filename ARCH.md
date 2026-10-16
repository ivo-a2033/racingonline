# Architecture

This project is a browser-based Phaser racing game with a small FastAPI WebSocket server. The browser owns the track, car physics, controls, sound, and rendering. The server serves the static page and relays player positions to connected clients.

## Files

- [`static/index.html`](static/index.html) loads Phaser from a CDN, defines the rear setup slider, and loads the game script.
- [`static/game.js`](static/game.js) creates and runs the game, including the Matter.js car, baked track textures, UI, audio, and multiplayer client.
- [`car.png`](car.png) is loaded as the local and remote car sprite.
- [`main.py`](main.py) serves the static files and car image, and implements the WebSocket position relay.
- [`requirements.txt`](requirements.txt) lists the Python server dependencies.

## Browser Startup

The browser loads `index.html`, which loads Phaser and then `game.js`. At script evaluation time, `game.js` defines its configuration, constants, state, and helper functions, then constructs `new Phaser.Game(config)`. Phaser calls `preload()` to load `/car.png`, creates the scene, and calls `create()` once. It then calls `update(time, delta)` repeatedly, once per frame.

### `create()` setup flow

1. Start the procedural audio loop with `makeEngineBuffer()` and `playProcGenSound()`.
2. Open a WebSocket to `/ws` and register a message handler that creates or updates remote-player ghost sprites.
3. Set world bounds and call `createTrack(this)` to generate the local track and bake its road and markings into sparse 512×512 textures. It returns centerline positions at each configured stripe interval, ordered so the third position is nearest the starting car.
4. Create three outlined pickup rectangles; the pickup WAV files were loaded during `preload()`. The rectangles rotate independently; collecting the pickup plays all three sounds and advances to the next stripe position.
5. Create the front and rear Matter bodies and connect them with three springs.
6. Connect the rear setup slider to `updateRearTuning()`, which applies its values to the rear body.
7. Create transparent body-following shapes, car image sprites, and skid-mark graphics; bind keyboard input, configure the camera, and add the zoom handler and controls text.

## Per-Frame Flow

Phaser calls `update(time, delta)` continuously after setup:

1. Send the local front-body position and rotation through the WebSocket, when connected.
2. Copy the physics body positions and angles to their transparent visual followers and sync the local car image to the bodies.
3. Rotate the pickup rectangles and check car proximity to the active pickup. On collection, play pickup sounds 2, 3, and 4 simultaneously, then move to the next stripe position.
4. Read acceleration, boost, and steering input. Apply forward drive force until the current speed reaches the configured limit.
5. Apply forward drag and lateral grip to both car bodies.
6. Apply the original rate-limited steering behavior. The rear setup slider adds a separate steering force that increases toward the heavier-rear end; its maximum is `CAR_CONFIG.maxRearTurnForceBoost`.
7. Update engine-rev state and generate skid marks while moving and steering or accelerating; skid marks expire after 450 frames.
8. Redraw skid marks and remove expired marks.

```mermaid
flowchart TD
    A[index.html loads Phaser and game.js] --> B[Phaser.Game config]
    B --> C[create once]
    C --> D[Create audio, WebSocket, track, car, UI]
    D --> E[update every frame]
    D --> M[Spawn pickup at third stripe position]
    M --> E
    E --> F[Input and drive force]
    E --> G[Drag, grip, and steering]
    E --> H[Network pose and visual sync]
    E --> I[Audio state and skid marks]
    E --> N[Rotate, collect, play pickup sounds, advance]
    J[Rear setup slider input] --> K[updateRearTuning]
    K --> L[Update rear body properties and readout]
```

## JavaScript Functions

### Configuration and state

- `CAR_CONFIG` contains drive and boost force, speed limits, lateral impulse limit, damping, drag, steering rate/timing, minimum steering speed, and the maximum extra turn force for the heavy-rear setup.
- `AUDIO_CONFIG` selects the procedural engine sound; it defaults to muted and can be changed with the engine sound selector.
- `REAR_TUNING` maps the slider's 0-to-1 value to rear-body density, friction, and air friction.
- `ROAD_TURN_AVERAGE_SEGMENTS` controls how many following segments contribute to the road stripe's smoothed turn color. `ROAD_FULL_BLUE_TURN_RADIANS` sets the turn angle that reaches full blue. `TRACK_TEXTURE_SIZE` and `TRACK_ROAD_HALF_WIDTH` control the sparse baked track tiles. `TRACK_STRIPE_INTERVAL` controls stripe spacing and pickup positions; `TRACK_ROAD_WIDTH` controls the dark road surface and pickup collision diameter, while `TRACK_STRIP_WIDTH` controls the colored center band. `PICKUP_CONFIG` controls rectangle appearance and rotation speeds.
- `config` configures Phaser, Matter physics, and the scene's `create` and `update` callbacks.
- Module-level variables hold the car bodies, input, camera zoom, skid-mark state, socket, remote ghost sprites, world size, engine audio state, and rear slider value. The camera starts at 0.8 zoom and wheel zoom changes by 0.0005 per delta unit.

### Functions

- `preload()` loads the car image used by the local and remote sprites and the three pickup sounds served by FastAPI.
- `createTrack(scene)` generates 720 points around a closed track, constrains the track to the world bounds, calculates smoothed segment turn factors, then rasterizes the road and markings into sparse 512×512 textures along the track. Dark and colored road strokes overlap segment ends by 20 pixels; the colored band uses 0.6 alpha. It returns positions sampled at `TRACK_STRIPE_INTERVAL` for pickup placement. The texture tiles render in place of per-frame vector Graphics drawing.
- `spawnNextPickup(scene)` places the pickup rectangles at the next sampled stripe position, cycling through the position list.
- `makeEngineBuffer(ctx, rev, duration)` synthesizes a short filtered engine-audio buffer based on the current rev value. It advances the shared engine phase and returns the audio buffer.
- `playProcGenSound(scene, audioBuffer)` plays an audio buffer and, when it ends, generates and starts the next one. This forms the continuous engine sound loop.
- `applyLateralGrip(scene, body, maxImpulse)` projects a body's velocity onto its local right axis and applies an opposing velocity change, limited by `maxImpulse`.
- `applyForwardDrag(scene, body, forwardX, forwardY, forwardSpeed)` applies a force opposing the car's forward motion, scaled by forward speed and the configured drag coefficient.
- `updateRearTuning(scene, amount, output)` interpolates the rear density, friction, and air friction from the slider value, updates the Matter body, and refreshes the displayed values. The same slider value is read by `update()` to calculate the added steering force.
- `create()` performs one-time scene setup. Phaser invokes it; it calls `makeEngineBuffer()`, `playProcGenSound()`, and `createTrack()`, and registers event handlers for WebSocket messages, the tuning slider, and mouse-wheel zoom.
- `update(time, delta)` is Phaser's recurring scene loop. It handles player networking, visual synchronization, input, acceleration, drag, grip, steering, engine-rev state, and skid-mark drawing and cleanup.

## Server and Multiplayer Flow

`main.py` creates the FastAPI application and a process-local `players` dictionary. Its `/car.png` route serves the root-level car asset, and `/audio/pickup-coin-{number}.wav` serves pickup sounds 2 through 4. The `multiplayer(websocket)` handler accepts each `/ws` connection, assigns it a server-side ID, then repeatedly receives a player's JSON position. It stores that position and sends the sender a list of the other connected players. On disconnect, it removes that connection from `players`.

The static-files mount serves `static/` at the site root, with `index.html` as the default page. When `main.py` is run directly, its `__main__` block starts Uvicorn on `0.0.0.0:8000` with reload enabled.

Track generation and car physics happen independently in each browser. The WebSocket currently relays position and rotation only; it does not synchronize the generated track, tuning slider, or physics state.