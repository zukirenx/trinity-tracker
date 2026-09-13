export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDisplayDate(isoDate: string): string {
  const [_year, month, day] = isoDate.split('-');
  if (!month || !day) {
    return isoDate;
  }
  return `${day}.${month}`;
}

export function truncateName(name: string, limit = 15): string {
  const trimmed = name.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

export function formatScoreMillions(score: number): string {
  if (!Number.isFinite(score)) {
    return '—';
  }
  if (score === 0) {
    return '0';
  }

  const millions = score / 1_000_000;
  const absMillions = Math.abs(millions);
  let formatted: string;
  if (absMillions >= 100) {
    formatted = millions.toFixed(0);
  } else if (absMillions >= 10) {
    formatted = millions.toFixed(1);
  } else {
    formatted = millions.toFixed(2);
  }

  return `${formatted}M`;
}

export function buildTableMessage(
  headerText: string,
  headerRow: string[],
  dataRows: string[][],
  alignments: Array<'left' | 'right'>
): { message: string; displayed: number } {
  // Pre-compute column widths across all data to avoid re-rendering
  const allRows = [headerRow, ...dataRows];
  const columnCount = headerRow.length;
  const colWidths = Array.from({ length: columnCount }, (_, colIndex) =>
    Math.max(...allRows.map(row => (row[colIndex] ?? '').length))
  );

  const formatRow = (row: string[]) =>
    row.map((cell, colIndex) => {
      const width = colWidths[colIndex];
      const align = alignments[colIndex] ?? 'left';
      return align === 'right' ? cell.padStart(width) : cell.padEnd(width);
    }).join('  ');

  const headerLine = formatRow(headerRow);
  const separator = colWidths.map((width, colIndex) => {
    const line = '-'.repeat(width);
    return (alignments[colIndex] ?? 'left') === 'right' ? line.padStart(width) : line.padEnd(width);
  }).join('  ');

  // Overhead: headerText + ```\n + header + sep + \n```
  const overhead = headerText.length + 5 + headerLine.length + 1 + separator.length + 1 + 4;
  let totalLength = overhead;
  const selectedRows: string[][] = [];

  for (const row of dataRows) {
    const rowLine = formatRow(row);
    const added = rowLine.length + 1; // +1 for newline
    if (totalLength + added > 1950 && selectedRows.length > 0) {
      break;
    }
    selectedRows.push(row);
    totalLength += added;
  }

  if (selectedRows.length === 0 && dataRows.length > 0) {
    selectedRows.push(dataRows[0]);
  }

  const lines = [headerLine, separator, ...selectedRows.map(formatRow)];
  const message = `${headerText}\n\u0060\u0060\u0060\n${lines.join('\n')}\n\u0060\u0060\u0060`;
  if (message.length > 2000) {
    const fallbackLines = selectedRows.map((row) => `${row[0]}. ${row[1]} – ${row[row.length - 1]}`);
    return {
      message: `${headerText}${fallbackLines.join('\n')}`.slice(0, 2000),
      displayed: Math.min(selectedRows.length, fallbackLines.length),
    };
  }

  return { message, displayed: selectedRows.length };
}

export function formatTableRows(rows: string[][], alignments: Array<'left' | 'right'>): string {
  if (rows.length === 0) {
    return '';
  }

  const columnCount = rows[0].length;
  const colWidths = Array.from({ length: columnCount }, (_, colIndex) =>
    Math.max(...rows.map(row => (row[colIndex] ?? '').length))
  );

  const lines = rows.map((row) =>
    row
      .map((cell, colIndex) => {
        const width = colWidths[colIndex];
        const align = alignments[colIndex] ?? 'left';
        return align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
  );

  if (rows.length > 1) {
    const separator = colWidths
      .map((width, colIndex) => {
        const align = alignments[colIndex] ?? 'left';
        const line = '-'.repeat(width);
        return align === 'right' ? line.padStart(width) : line.padEnd(width);
      })
      .join('  ');
    lines.splice(1, 0, separator);
  }

  return lines.join('\n');
}

export function formatLeaderboardLabel(meta: { title: string | null; slug: string } | null): string | null {
  if (!meta) {
    return null;
  }

  if (meta.title) {
    const weekMatch = meta.title.match(/Week\s+(\d{1,2})/i);
    if (weekMatch) {
      return `Week ${parseInt(weekMatch[1], 10)}`;
    }
  }

  const slugMatch = meta.slug.match(/ww(\d{1,2})/i);
  if (slugMatch) {
    return `Week ${parseInt(slugMatch[1], 10)}`;
  }

  return meta.title ?? meta.slug;
}
