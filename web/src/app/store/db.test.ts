import "fake-indexeddb/auto";
import { all, get, makeBackup, put, remove, restoreBackup, clear } from "./db";

describe("storage on the device", () => {
  it("keeps players and matches, and a backup brings them back", async () => {
    await put("players", { id: "p1", number: 7, name: "Sanne", role: "OH" });
    await put("matches", { id: "m1", opponent: "Dynamo", events: [{ kind: "point", side: "home" }] });
    expect((await get<{ name: string }>("players", "p1"))?.name).toBe("Sanne");
    const backup = JSON.parse(JSON.stringify(await makeBackup()));
    await clear("players");
    await remove("matches", "m1");
    expect(await all("players")).toHaveLength(0);
    expect(await restoreBackup(backup)).toBe(2);
    expect((await get<{ events: unknown[] }>("matches", "m1"))?.events).toHaveLength(1);
  });
});

describe("restoring a backup", () => {
  it("keeps a video's clip when the backup was made without clips", async () => {
    await put("videos", { id: "v1", title: "Rally", clip: new Blob(["frames"], { type: "video/mp4" }) });
    const light = JSON.parse(JSON.stringify(await makeBackup(false)));
    await restoreBackup(light);
    const v = await get<{ clip?: Blob }>("videos", "v1");
    expect(v?.clip).toBeDefined();
  });

  it("keeps the newer match and board on the iPad", async () => {
    await put("matches", { id: "m2", journal: "AAAA" });
    await put("boards", { id: "b1", title: "Old", modifiedAt: "2026-01-01T00:00:00.000Z" });
    const old = JSON.parse(JSON.stringify(await makeBackup()));
    await put("matches", { id: "m2", journal: "AAAABBBB" });
    await put("boards", { id: "b1", title: "New", modifiedAt: "2026-02-01T00:00:00.000Z" });
    await restoreBackup(old);
    expect((await get<{ journal: string }>("matches", "m2"))?.journal).toBe("AAAABBBB");
    expect((await get<{ title: string }>("boards", "b1"))?.title).toBe("New");
  });

  it("changes nothing when the file is damaged", async () => {
    await clear("players");
    const bad = { format: "coachboard-backup/1", createdAt: "", stores: { players: [{ id: "p9", number: 9 }, { number: 10 }] } };
    await expect(restoreBackup(bad as never)).rejects.toThrow();
    expect(await all("players")).toHaveLength(0);
  });
});
