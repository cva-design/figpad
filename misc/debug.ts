import createDebug from 'debug';

const url = new URL(import.meta.url);
const [namespace] = [...url.searchParams][0];

export default createDebug(namespace);