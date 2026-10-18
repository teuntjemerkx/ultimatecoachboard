import { VideoScene, type TrackLock, type VideoSceneJSON } from "../../core/video";
import { all, get, put, remove } from "../store/db";

/**
 * A rebuilt rally as kept in the IndexedDB `videos` store: the scene, the clip it came from and the clean plate of
 * the hall. A backup without videos leaves `clip` out; the rally then plays over the plate.
 */
export interface StoredVideo {
  id: string;
  title: string;
  /** ISO date. */
  createdAt: string;
  duration: number;
  scene: VideoSceneJSON;
  clip?: Blob;
  /** The clean plate (the empty hall as the camera saw it), JPEG. */
  plate?: Blob;
  /** The players the coach tapped for the build (to put a player right and build again). */
  locks?: TrackLock[];
}

export async function listVideos(): Promise<StoredVideo[]> {
  const items = await all<StoredVideo>("videos");
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadVideo(id: string): Promise<{ stored: StoredVideo; scene: VideoScene } | undefined> {
  const stored = await get<StoredVideo>("videos", id);
  if (!stored) return undefined;
  return { stored, scene: VideoScene.decode(stored.scene) };
}

export async function saveVideo(scene: VideoScene, clip: Blob | undefined, plate: Blob | undefined, locks?: TrackLock[]): Promise<StoredVideo> {
  const item: StoredVideo = {
    id: scene.id, title: scene.title, createdAt: new Date().toISOString(), duration: scene.duration, scene: scene.encode(),
  };
  if (clip) item.clip = clip;
  if (plate) item.plate = plate;
  if (locks && locks.length > 0) item.locks = locks;
  await put("videos", item);
  return item;
}

export async function deleteVideo(id: string): Promise<void> {
  await remove("videos", id);
}
