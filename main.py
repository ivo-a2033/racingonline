from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI()
players = {}


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