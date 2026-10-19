"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/client";
import { interpolate } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  getRowId?: (row: T) => string;
  searchable?: boolean;
  searchPlaceholder?: string;
  selectable?: boolean;
  /** Rendered in the toolbar when rows are selected; receives selected rows. */
  bulkActions?: (rows: T[], clear: () => void) => React.ReactNode;
  toolbar?: React.ReactNode;
  pageSize?: number;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  initialSorting?: SortingState;
  initialHidden?: string[];
  className?: string;
  dense?: boolean;
}

export function DataTable<T>({
  data,
  columns,
  getRowId,
  searchable = true,
  searchPlaceholder,
  selectable = false,
  bulkActions,
  toolbar,
  pageSize = 50,
  empty,
  onRowClick,
  rowClassName,
  initialSorting = [],
  initialHidden = [],
  className,
  dense = true,
}: DataTableProps<T>) {
  const { m } = useI18n();
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [visibility, setVisibility] = useState<VisibilityState>(() => Object.fromEntries(initialHidden.map((c) => [c, false])));

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const select: ColumnDef<T, unknown> = {
      id: "__select",
      size: 32,
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => (
        <Checkbox
          aria-label="select all"
          checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) => <Checkbox aria-label="select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} />,
    };
    return [select, ...columns];
  }, [columns, selectable]);

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, globalFilter, rowSelection, columnVisibility: visibility },
    getRowId: getRowId ? (r) => getRowId(r) : undefined,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    enableRowSelection: selectable,
    globalFilterFn: "includesString",
  });

  const selected = table.getSelectedRowModel().rows.map((r) => r.original);
  const filteredCount = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize: ps } = table.getState().pagination;
  const from = filteredCount ? pageIndex * ps + 1 : 0;
  const to = Math.min(filteredCount, (pageIndex + 1) * ps);
  const clear = () => setRowSelection({});

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {searchable && (
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} placeholder={searchPlaceholder ?? m.common.searchPlaceholder} className="h-8 ps-8 text-sm" />
            {globalFilter && (
              <button className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setGlobalFilter("")} aria-label={m.common.clearFilters}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
        {toolbar}
        <div className="ms-auto flex items-center gap-2">
          {selectable && selected.length > 0 && (
            <div className="flex items-center gap-2 rounded-md bg-jade-soft px-2 py-1 text-xs text-primary">
              <span className="font-medium">{interpolate(m.common.selected, { count: selected.length })}</span>
              {bulkActions?.(selected, clear)}
              <button onClick={clear} className="opacity-70 hover:opacity-100" aria-label={m.common.clearFilters}>
                <X className="size-3.5" />
              </button>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 text-muted-foreground">
                <Columns3 className="size-3.5" />
                <span className="hidden md:inline">{m.common.columns}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
                    {typeof c.columnDef.header === "string" ? c.columnDef.header : c.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b">
                {hg.headers.map((h) => {
                  const sort = h.column.getIsSorted();
                  const canSort = h.column.getCanSort();
                  return (
                    <th key={h.id} className="h-8 px-3 text-start align-middle text-xs font-medium whitespace-nowrap text-muted-foreground" style={{ width: h.column.columnDef.size }}>
                      {h.isPlaceholder ? null : canSort ? (
                        <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sort === "asc" ? <ArrowUp className="size-3" /> : sort === "desc" ? <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={cn("border-b last:border-0 hover:bg-muted/40 data-[state=selected]:bg-jade-soft/60", onRowClick && "cursor-pointer", rowClassName?.(row.original))}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cn("px-3 align-middle", dense ? "h-10" : "h-12")}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCount === 0 && <div className="py-10 text-center text-sm text-muted-foreground">{empty ?? m.common.noResults}</div>}
      </div>
      {filteredCount > ps && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="tabular">{interpolate(m.common.showing, { from, to, total: filteredCount })}</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              {m.common.previous}
            </Button>
            <Button variant="outline" size="sm" className="h-7" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              {m.common.next}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
