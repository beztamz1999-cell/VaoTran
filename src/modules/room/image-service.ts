import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DomainError, config } from '../../platform/core.js';
import type { PostgresDatabase } from '../../platform/database/db.js';

type ImageRow = { id: string; room_id: string; storage_key: string; mime_type: string; sort_order: number; is_cover: boolean; created_at: Date };
export type RoomImage = { id: string; url: string; mimeType: string; sortOrder: number; isCover: boolean };

const maxBytes = 6 * 1024 * 1024;
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const magicMatches = (body: Buffer, mime: string) => (
  (mime === 'image/jpeg' && body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
  || (mime === 'image/png' && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  || (mime === 'image/webp' && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP')
);
const dto = (row: ImageRow): RoomImage => ({ id: row.id, url: `/api/v1/room-images/${encodeURIComponent(row.storage_key)}`, mimeType: row.mime_type, sortOrder: row.sort_order, isCover: row.is_cover });

export class LocalRoomImageStorage {
  private readonly directory = config.roomImageStorageDir;
  async put(key: string, body: Buffer): Promise<void> { await mkdir(this.directory, { recursive: true }); await writeFile(join(this.directory, basename(key)), body, { flag: 'wx' }); }
  async delete(key: string): Promise<void> { await unlink(join(this.directory, basename(key))).catch(() => undefined); }
  async read(key: string): Promise<Buffer | null> { try { return await readFile(join(this.directory, basename(key))); } catch { return null; } }
}

export class RoomImageService {
  constructor(private readonly db: PostgresDatabase, private readonly storage = new LocalRoomImageStorage()) {}
  async list(roomId: string): Promise<RoomImage[]> { const result = await this.db.query<ImageRow>('SELECT * FROM room_images WHERE room_id=$1 ORDER BY sort_order, created_at', [roomId]); return result.rows.map(dto); }
  async cover(roomId: string): Promise<RoomImage | null> { const result = await this.db.query<ImageRow>('SELECT * FROM room_images WHERE room_id=$1 AND is_cover=true LIMIT 1', [roomId]); return result.rows[0] ? dto(result.rows[0]) : null; }
  async add(actorUserId: string, roomId: string, mimeType: string, body: Buffer): Promise<RoomImage> {
    if (!extensions[mimeType] || !magicMatches(body, mimeType)) throw new DomainError('VALIDATION_ERROR', 'UNSUPPORTED_IMAGE_TYPE');
    if (body.length === 0 || body.length > maxBytes) throw new DomainError('VALIDATION_ERROR', 'IMAGE_TOO_LARGE');
    const key = `${randomUUID()}.${extensions[mimeType]}`;
    await this.assertHost(actorUserId, roomId);
    await this.storage.put(key, body);
    try {
      return await this.db.transaction(async (tx) => {
        const room = await tx.query<{ host_user_id: string }>('SELECT host_user_id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
        if (!room.rows[0]) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
        if (room.rows[0].host_user_id !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may manage images.');
        const count = await tx.query<{ count: string }>('SELECT count(*) FROM room_images WHERE room_id=$1', [roomId]);
        if (Number(count.rows[0]?.count ?? 0) >= 3) throw new DomainError('VALIDATION_ERROR', 'ROOM_IMAGE_LIMIT_REACHED');
        const order = await tx.query<{ value: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM room_images WHERE room_id=$1', [roomId]);
        const isCover = Number(count.rows[0]?.count ?? 0) === 0;
        const row: ImageRow = { id: randomUUID(), room_id: roomId, storage_key: key, mime_type: mimeType, sort_order: order.rows[0]?.value ?? 0, is_cover: isCover, created_at: new Date() };
        await tx.query('INSERT INTO room_images (id,room_id,storage_key,mime_type,sort_order,is_cover,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [row.id, row.room_id, row.storage_key, row.mime_type, row.sort_order, row.is_cover, row.created_at]);
        return dto(row);
      });
    } catch (error) { await this.storage.delete(key); throw error; }
  }
  async setCover(actorUserId: string, roomId: string, imageId: string): Promise<void> { await this.db.transaction(async tx => { await this.assertHost(actorUserId, roomId, tx); const found = await tx.query<ImageRow>('SELECT * FROM room_images WHERE id=$1 AND room_id=$2 FOR UPDATE', [imageId, roomId]); if (!found.rows[0]) throw new DomainError('VALIDATION_ERROR', 'ROOM_IMAGE_NOT_FOUND'); await tx.query('UPDATE room_images SET is_cover=false WHERE room_id=$1', [roomId]); await tx.query('UPDATE room_images SET is_cover=true WHERE id=$1', [imageId]); }); }
  async remove(actorUserId: string, roomId: string, imageId: string): Promise<void> { const key = await this.db.transaction(async tx => { await this.assertHost(actorUserId, roomId, tx); const found = await tx.query<ImageRow>('DELETE FROM room_images WHERE id=$1 AND room_id=$2 RETURNING *', [imageId, roomId]); const removed = found.rows[0]; if (!removed) throw new DomainError('VALIDATION_ERROR', 'ROOM_IMAGE_NOT_FOUND'); if (removed.is_cover) await tx.query('UPDATE room_images SET is_cover=true WHERE id=(SELECT id FROM room_images WHERE room_id=$1 ORDER BY sort_order, created_at LIMIT 1)', [roomId]); return removed.storage_key; }); await this.storage.delete(key); }
  async read(key: string): Promise<Buffer | null> { return this.storage.read(key); }
  private async assertHost(actorUserId: string, roomId: string, executor: { query: PostgresDatabase['query'] } = this.db): Promise<void> { const result = await executor.query<{ host_user_id: string }>('SELECT host_user_id FROM rooms WHERE id=$1', [roomId]); if (!result.rows[0]) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.'); if (result.rows[0].host_user_id !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may manage images.'); }
}
