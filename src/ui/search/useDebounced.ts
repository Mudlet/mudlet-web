import { useEffect, useState } from 'react';

/** Return `value` delayed by `delay` ms — collapses bursts of keystrokes so an
 *  expensive scan runs at most once per pause in typing. */
export function useDebounced<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const id = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(id);
    }, [value, delay]);
    return debounced;
}
