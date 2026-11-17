// Pages are numbered from 1.
export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    totalPages: Math.floor(items.length / pageSize),
  };
}
