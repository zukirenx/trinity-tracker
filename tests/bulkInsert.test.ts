import { describe, it, expect } from 'vitest';

describe('Bulk Insert SQL Generation', () => {
  it('should generate correct placeholders for member insert', () => {
    const batch = ['player1', 'player2', 'player3'];
    const insertPlaceholders = batch.map(() => '(?, ?, 1)').join(', ');
    const insertValues: any[] = [];
    
    for (const normalized of batch) {
      insertValues.push(normalized, normalized);
    }
    
    console.log('Placeholders:', insertPlaceholders);
    console.log('Values count:', insertValues.length);
    console.log('Values:', insertValues);
    
    expect(insertPlaceholders).toBe('(?, ?, 1), (?, ?, 1), (?, ?, 1)');
    expect(insertValues.length).toBe(6); // 2 params per member
  });

  it('should generate correct placeholders for reward insert', () => {
    const batch = [
      { date: '2026-01-01', driverName: 'Player1', vipName: null, type: 'TRAIN', rawText: 'test', sourceMessageId: '123', sourceLine: 0 },
      { date: '2026-01-01', driverName: 'Player2', vipName: 'Player3', type: 'VIP', rawText: 'test2', sourceMessageId: '124', sourceLine: 1 },
    ];
    
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values: any[] = [];
    
    for (const r of batch) {
      values.push(r.date, r.driverName, r.vipName || null, r.type, r.rawText, r.sourceMessageId, r.sourceLine);
    }
    
    console.log('Placeholders:', placeholders);
    console.log('Values count:', values.length);
    console.log('Values:', values);
    
    expect(placeholders).toBe('(?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)');
    expect(values.length).toBe(14); // 7 params per reward
  });

  it('should not exceed 999 params with batch size 20 for members', () => {
    const batch = Array.from({ length: 20 }, (_, i) => `player${i}`);
    const insertValues: any[] = [];
    
    for (const normalized of batch) {
      insertValues.push(normalized, normalized);
    }
    
    console.log('Batch size:', batch.length);
    console.log('Total params:', insertValues.length);
    
    expect(insertValues.length).toBe(40); // Should be safe
    expect(insertValues.length).toBeLessThan(999);
  });

  it('should not exceed 999 params with batch size 20 for rewards', () => {
    const batch = Array.from({ length: 20 }, (_, i) => ({
      date: '2026-01-01',
      driverName: `Player${i}`,
      vipName: null,
      type: 'TRAIN',
      rawText: 'test',
      sourceMessageId: '123',
      sourceLine: i,
    }));
    
    const values: any[] = [];
    for (const r of batch) {
      values.push(r.date, r.driverName, r.vipName || null, r.type, r.rawText, r.sourceMessageId, r.sourceLine);
    }
    
    console.log('Batch size:', batch.length);
    console.log('Total params:', values.length);
    
    expect(values.length).toBe(140); // Should be safe
    expect(values.length).toBeLessThan(999);
  });

  it('should handle edge case of 150+ members across multiple batches', () => {
    const INSERT_BATCH = 20;
    const members = Array.from({ length: 151 }, (_, i) => `player${i}`);
    
    let totalParams = 0;
    let batchCount = 0;
    
    for (let i = 0; i < members.length; i += INSERT_BATCH) {
      const batch = members.slice(i, i + INSERT_BATCH);
      const insertValues: any[] = [];
      
      for (const normalized of batch) {
        insertValues.push(normalized, normalized);
      }
      
      batchCount++;
      console.log(`Batch ${batchCount}: ${batch.length} members, ${insertValues.length} params`);
      
      expect(insertValues.length).toBeLessThanOrEqual(40); // Max for batch of 20
      totalParams += insertValues.length;
    }
    
    console.log('Total batches:', batchCount);
    console.log('Total members:', members.length);
    console.log('Total params across all batches:', totalParams);
    
    expect(batchCount).toBe(8); // 151 / 20 = 7.55, rounded up to 8
  });
});
