// Pages are numbered from 1.
export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    totalPages: Math.ceil(items.length / pageSize),
  };
}
