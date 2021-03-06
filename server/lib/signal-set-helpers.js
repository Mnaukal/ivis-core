"use strict";
const {getIndexName} = require('./indexers/elasticsearch-common');

const allowedKeysCreate = new Set(['cid', 'type', 'name', 'description', 'namespace', 'record_id_template', 'settings', 'kind', 'metadata']);
const allowedKeysUpdate = new Set(['name', 'description', 'namespace', 'record_id_template', 'settings', 'kind', 'metadata']);

function getSignalSetEntitySpec(signalSet) {
    return {
        ...signalSet,
        index: getIndexName(signalSet),
    };
}

module.exports = {
    allowedKeysCreate,
    allowedKeysUpdate,
    getSignalSetEntitySpec
};

