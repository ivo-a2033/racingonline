from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
players = {}


@app.get("/car.png")
async def car_image():
    return FileResponse(Path(__file__).resolve().parent / "car2.png", media_type="image/png")


@app.get("/audio/pickup-coin-{number}.wav")
async def pickup_audio(number: str):
    if number not in {"2", "3", "4"}:
        raise HTTPException(status_code=404, detail="Pickup audio not found")
    return FileResponse(
        Path(__file__).resolve().parent / f"pickupCoin({number}).wav",
        media_type="audio/wav",
    )


@app.websocket("/ws")
async def multiplayer(websocket: WebSocket):
    await websocket.accept()
    player_id = str(id(websocket))
    try:
        while True:
            player = await websocket.receive_json()
            players[player_id] = {"id": player_id, **player}
            await websocket.send_json([p for key, p in players.items() if key != player_id])
    except WebSocketDisconnect:
        players.pop(player_id, None)

# Serve everything in ./static at the root.
# html=True makes / serve index.html automatically.
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)