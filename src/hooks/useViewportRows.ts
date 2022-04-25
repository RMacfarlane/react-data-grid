import { useMemo } from 'react';
import { floor, max, min } from '../utils';
import type { GroupRow, Maybe, RowHeightArgs } from '../types';

type GroupByDictionary<TRow> = Record<
  string,
  {
    readonly childRows: readonly TRow[];
    readonly childGroups: readonly TRow[] | Readonly<GroupByDictionary<TRow>>;
    readonly startRowIndex: number;
  }
>;

interface ViewportRowsArgs<R> {
  rawRows: readonly R[];
  rowHeight: number | ((args: RowHeightArgs<R>) => number);
  scrollTop: number;
  groupBy: readonly string[];
  rowGrouper: Maybe<(rows: readonly R[], columnKey: string) => Record<string, readonly R[]>>;
  expandedGroupIds: Maybe<ReadonlySet<unknown>>;
  enableVirtualization: boolean;
  headerRowHeight: number;
  gridHeight: number;
  summaryRowsCount: number;
  summaryRowHeight: number;
}

// TODO: https://github.com/microsoft/TypeScript/issues/41808
function isReadonlyArray(arr: unknown): arr is readonly unknown[] {
  return Array.isArray(arr);
}

export function useViewportRows<R>({
  rawRows,
  rowHeight,
  scrollTop,
  groupBy,
  rowGrouper,
  expandedGroupIds,
  enableVirtualization,
  headerRowHeight,
  gridHeight,
  summaryRowsCount,
  summaryRowHeight
}: ViewportRowsArgs<R>) {
  const [groupedRows, rowsCount] = useMemo(() => {
    if (groupBy.length === 0 || rowGrouper == null) return [undefined, rawRows.length];

    const groupRows = (
      rows: readonly R[],
      [groupByKey, ...remainingGroupByKeys]: readonly string[],
      startRowIndex: number
    ): [Readonly<GroupByDictionary<R>>, number] => {
      let groupRowsCount = 0;
      const groups: GroupByDictionary<R> = {};
      for (const [key, childRows] of Object.entries(rowGrouper(rows, groupByKey))) {
        // Recursively group each parent group
        const [childGroups, childRowsCount] =
          remainingGroupByKeys.length === 0
            ? [childRows, childRows.length]
            : groupRows(childRows, remainingGroupByKeys, startRowIndex + groupRowsCount + 1); // 1 for parent row
        groups[key] = { childRows, childGroups, startRowIndex: startRowIndex + groupRowsCount };
        groupRowsCount += childRowsCount + 1; // 1 for parent row
      }

      return [groups, groupRowsCount];
    };

    return groupRows(rawRows, groupBy, 0);
  }, [groupBy, rowGrouper, rawRows]);

  const [rows, isGroupRow] = useMemo((): [
    ReadonlyArray<R | GroupRow<R>>,
    (row: R | GroupRow<R>) => row is GroupRow<R>
  ] => {
    const allGroupRows = new Set<unknown>();
    if (!groupedRows) return [rawRows, isGroupRow];

    const flattenedRows: Array<R | GroupRow<R>> = [];
    const expandGroup = (
      rows: GroupByDictionary<R> | readonly R[],
      parentId: string | undefined,
      level: number
    ): void => {
      if (isReadonlyArray(rows)) {
        flattenedRows.push(...rows);
        return;
      }
      Object.keys(rows).forEach((groupKey, posInSet, keys) => {
        // TODO: should users have control over the generated key?
        const id = parentId !== undefined ? `${parentId}__${groupKey}` : groupKey;
        const isExpanded = expandedGroupIds?.has(id) ?? false;
        const { childRows, childGroups, startRowIndex } = rows[groupKey];

        const groupRow: GroupRow<R> = {
          id,
          parentId,
          groupKey,
          isExpanded,
          childRows,
          level,
          posInSet,
          startRowIndex,
          setSize: keys.length
        };
        flattenedRows.push(groupRow);
        allGroupRows.add(groupRow);

        if (isExpanded) {
          expandGroup(childGroups, id, level + 1);
        }
      });
    };

    expandGroup(groupedRows, undefined, 0);
    return [flattenedRows, isGroupRow];

    function isGroupRow(row: R | GroupRow<R>): row is GroupRow<R> {
      return allGroupRows.has(row);
    }
  }, [expandedGroupIds, groupedRows, rawRows]);

  const stickyRowIndexes = useMemo(() => {
    const stickyRowInfo: number[] = []
    rows.forEach((r, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof r === 'object' && (r as any).isStickyRow) {
        stickyRowInfo.push(i)
      }
    })

    return stickyRowInfo
  }, [rows])

  const { totalRowHeight, getRowTop, getRowHeight, findRowIdx } = useMemo(() => {
    if (typeof rowHeight === 'number') {
      return {
        totalRowHeight: rowHeight * rows.length,
        getRowTop: (rowIdx: number) => rowIdx * rowHeight,
        getRowHeight: () => rowHeight,
        findRowIdx: (offset: number) => floor(offset / rowHeight)
      };
    }

    let totalRowHeight = 0;
    // Calcule the height of all the rows upfront. This can cause performance issues
    // and we can consider using a similar approach as react-window
    // https://github.com/bvaughn/react-window/blob/b0a470cc264e9100afcaa1b78ed59d88f7914ad4/src/VariableSizeList.js#L68
    const rowPositions = rows.map((row: R | GroupRow<R>) => {
      const currentRowHeight = isGroupRow(row)
        ? rowHeight({ type: 'GROUP', row })
        : rowHeight({ type: 'ROW', row });
      const position = { top: totalRowHeight, height: currentRowHeight };
      totalRowHeight += currentRowHeight;
      return position;
    });

    const validateRowIdx = (rowIdx: number) => {
      return max(0, min(rows.length - 1, rowIdx));
    };

    return {
      totalRowHeight,
      getRowTop: (rowIdx: number) => rowPositions[validateRowIdx(rowIdx)].top,
      getRowHeight: (rowIdx: number) => rowPositions[validateRowIdx(rowIdx)].height,
      findRowIdx(offset: number) {
        let start = 0;
        let end = rowPositions.length - 1;
        while (start <= end) {
          const middle = start + floor((end - start) / 2);
          const currentOffset = rowPositions[middle].top;

          if (currentOffset === offset) return middle;

          if (currentOffset < offset) {
            start = middle + 1;
          } else if (currentOffset > offset) {
            end = middle - 1;
          }

          if (start > end) return end;
        }
        return 0;
      }
    };
  }, [isGroupRow, rowHeight, rows]);

  const stickyRowIndex = useMemo(() => {
    if (!stickyRowIndexes.length) {
      return undefined
    }

    const rowVisibleStartIdx = findRowIdx(scrollTop);
    for (const [i, rowIndex] of stickyRowIndexes.entries()) {
      if (rowIndex === rowVisibleStartIdx) {
        return i
      }

      if (stickyRowIndexes[i] > rowVisibleStartIdx) {
        return i === 0 ? i : i - 1
      }
    }

    return stickyRowIndexes.length - 1
  }, [stickyRowIndexes, findRowIdx, scrollTop])

  let rowOverscanStartIdx = 0;
  let rowOverscanEndIdx = rows.length - 1;

  const stickyRowHeight = stickyRowIndex !== undefined ? headerRowHeight : 0;
  const clientHeight =
    gridHeight - headerRowHeight - stickyRowHeight - summaryRowsCount * summaryRowHeight;

  if (enableVirtualization) {
    const overscanThreshold = 4;
    const rowVisibleStartIdx = findRowIdx(scrollTop);
    const rowVisibleEndIdx = findRowIdx(scrollTop + clientHeight);
    rowOverscanStartIdx = max(0, rowVisibleStartIdx - overscanThreshold);
    rowOverscanEndIdx = min(rows.length - 1, rowVisibleEndIdx + overscanThreshold);
  }

  return {
    rowOverscanStartIdx,
    rowOverscanEndIdx,
    rows,
    rowsCount,
    totalRowHeight,
    isGroupRow,
    getRowTop,
    getRowHeight,
    findRowIdx,
    stickyRowIndexes,
    stickyRowIndex,
    clientHeight
  };
}
