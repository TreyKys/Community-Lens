'use client';

import { useMemo, useState, ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Column<T> = {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number | Date;
  className?: string;
};

type BulkAction<T> = {
  label: string;
  onClick: (rows: T[]) => void | Promise<void>;
  variant?: 'default' | 'destructive' | 'outline';
  disabled?: (rows: T[]) => boolean;
};

type Props<T> = {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  searchFields?: (row: T) => string;
  pageSize?: number;
  bulkActions?: BulkAction<T>[];
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchFields,
  pageSize = 10,
  bulkActions,
  emptyMessage = 'No records',
  onRowClick,
}: Props<T>) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());

  const filtered = useMemo(() => {
    let out = rows;
    if (query.trim() && searchFields) {
      const q = query.toLowerCase();
      out = out.filter((r) => searchFields(r).toLowerCase().includes(q));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col?.sortValue) {
        const getValue = col.sortValue;
        out = [...out].sort((a, b) => {
          const av = getValue(a);
          const bv = getValue(b);
          if (av < bv) return sortDir === 'asc' ? -1 : 1;
          if (av > bv) return sortDir === 'asc' ? 1 : -1;
          return 0;
        });
      }
    }
    return out;
  }, [rows, query, sortKey, sortDir, columns, searchFields]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(current * pageSize, (current + 1) * pageSize);

  const toggleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    }
  };

  const toggleRow = (id: string | number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (pageRows.every((r) => selected.has(rowKey(r)))) {
      const next = new Set(selected);
      pageRows.forEach((r) => next.delete(rowKey(r)));
      setSelected(next);
    } else {
      const next = new Set(selected);
      pageRows.forEach((r) => next.add(rowKey(r)));
      setSelected(next);
    }
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(rowKey(r))),
    [rows, selected, rowKey]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        {searchFields && (
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              className="pl-9 h-9"
            />
          </div>
        )}
        <div className="text-xs text-muted-foreground ml-auto">
          {filtered.length} record{filtered.length !== 1 ? 's' : ''}
          {selected.size > 0 && ` • ${selected.size} selected`}
        </div>
      </div>

      {bulkActions && selected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-muted/30 border border-muted rounded-lg">
          <span className="text-xs text-muted-foreground ml-2">{selected.size} selected</span>
          <div className="flex gap-1 ml-auto">
            {bulkActions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.variant || 'outline'}
                disabled={action.disabled?.(selectedRows) ?? false}
                onClick={async () => {
                  await action.onClick(selectedRows);
                  setSelected(new Set());
                }}
                className="h-7 text-xs"
              >
                {action.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-muted overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                {bulkActions && (
                  <th className="w-10 p-2 text-left">
                    <Checkbox
                      checked={pageRows.length > 0 && pageRows.every((r) => selected.has(rowKey(r)))}
                      onCheckedChange={toggleAll}
                    />
                  </th>
                )}
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={cn('p-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider', col.className)}
                  >
                    {col.sortable ? (
                      <button
                        onClick={() => toggleSort(col.key)}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        {col.label}
                        {sortKey === col.key ? (
                          sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + (bulkActions ? 1 : 0)}
                    className="p-12 text-center text-muted-foreground text-sm"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => {
                  const id = rowKey(row);
                  const isSelected = selected.has(id);
                  return (
                    <tr
                      key={id}
                      className={cn(
                        'border-t border-muted transition-colors',
                        isSelected && 'bg-primary/5',
                        onRowClick && 'cursor-pointer hover:bg-muted/20'
                      )}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {bulkActions && (
                        <td className="p-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={isSelected} onCheckedChange={() => toggleRow(id)} />
                        </td>
                      )}
                      {columns.map((col) => (
                        <td key={col.key} className={cn('p-2', col.className)}>
                          {col.render ? col.render(row) : (row as any)[col.key]}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {current + 1} of {pageCount}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft className="w-3 h-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2"
              disabled={current === pageCount - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
