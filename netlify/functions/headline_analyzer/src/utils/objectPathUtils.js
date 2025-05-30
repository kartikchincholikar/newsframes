// src/utils/objectPathUtils.js
/**
 * Safely resolves a dot-separated path string within an object.
 * @param {object} obj The object to traverse.
 * @param {string} pathString The dot-separated path (e.g., "a.b.c").
 * @param {*} [defaultValue=undefined] Value to return if path is not found or invalid.
 * @returns {*} The value at the path or the defaultValue.
 */
function resolvePath(obj, pathString, defaultValue = undefined) {
    if (typeof pathString !== 'string' || !pathString) {
        // If pathString is not a valid string, or empty, decide what to return.
        // If obj itself is the target (e.g. path is empty meaning "self"), return obj.
        // Or if an empty path means an error/undefined, handle that.
        // For now, assume empty/invalid path means use defaultValue or obj if path is truly meant to be empty.
        return (pathString === '' && obj !== undefined) ? obj : defaultValue;
    }
    const path = pathString.split('.');
    let current = obj;
    for (let i = 0; i < path.length; i++) {
        if (current === null || typeof current !== 'object' || !current.hasOwnProperty(path[i])) {
            return defaultValue;
        }
        current = current[path[i]];
    }
    return current;
}

module.exports = {
    resolvePath,
};