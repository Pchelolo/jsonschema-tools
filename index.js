#!/usr/bin/env node
'use strict';

const _        = require('lodash');
const yaml     = require('js-yaml');
const path = require('path');
const semver = require('semver');
const fse = require('fs-extra');
const pino = require('pino');
const neodoc = require('neodoc');

const defaultOptions = {
    shouldSymlink: true,
    contentType: 'yaml',
    schemaVersionField: '$id',
    shouldGitAdd: true,
    dryRun: false,
    log: pino({level: 'warn', prettyPrint: true}),
};


const serializers = {
    'yaml': yaml.dump,
    'json': JSON.stringify
};


const usage = `
usage: jsonschema-materialize [options] <schema-path> [-]

Given a path to a JSONSchema file, this will extract the schema version
and output a file named for the version with the derefenced schema.
If the schema is given on stdin, it will be used instead of reading
the schema from the <schema-path> file.

options:
    -h, --help
    -c, --content-type <content-type>       [Default: ${defaultOptions.contentType}]
    -V, --version-field <version-field>     [Default: ${defaultOptions.schemaVersionField}]
    -G, --no-git-add
    -S, --no-symlink
    -v, --verbose
    -n, --dry-run
`;
const parsedUsage = neodoc.parse(usage, {smartOptions: true});


/**
 * Converts a utf-8 byte buffer or a YAML/JSON string into
 * an object and returns it.
 * @param {string|Buffer|Object} data
 * @return {Object}
 */
function objectFactory(data) {
    // If we were given a byte Buffer, parse it as utf-8 string.
    if (data instanceof Buffer) {
        data = data.toString('utf-8');
    } else if (_.isObject(data)) {
        // if we were given a a JS object, return it now.
        return data;
    }

    // If we now have a string, then assume it is a YAML/JSON string.
    if (_.isString(data)) {
        data = yaml.safeLoad(data);
    } else {
        throw new Error(
            'Could not convert data into an object.  ' +
            'Data must be a utf-8 byte buffer or a YAML/JSON string'
        );
    }

    return data;
}





function writeSchemaFile(object, outputPath, options={}) {
    _.defaults(options, defaultOptions);
    const contentType = options.contentType;

    const serialize = serializers[contentType];
    if (_.isUndefined(serialize)) {
        throw new Error(
            `Cannot write schema file to ${outputPath}, ` +
            `no serializer for ${contentType} is defined.`
        );
    }

    return fse.writeFile(outputPath, serialize(object));
}


function schemaVersion(schema, schemaVersionField) {
    return semver.coerce(_.get(schema, schemaVersionField)).version;
}

async function readSchemaFile(schemaPath) {
    const content = await fse.readFile(schemaPath);
    return yaml.safeLoad(content.toString('utf-8'));
}

function extensionlessPath(filePath) {
    const parsedPath = path.parse(filePath);
    return path.join(parsedPath.dir, parsedPath.name);
}

async function createSymlink(filePath, symlinkPath) {
    const parsedPath = path.parse(filePath);
    const fileName = parsedPath.base;

    try {
        await fse.access(symlinkPath, fse.constants.F_OK | fse.constants.W_OK);
        await fse.unlink(symlinkPath);
    } catch (err) {
        if (err.code == 'ENOENT') {
            // no op, the file doesn't exist so we can just create a new symlink
        } else {
            console.log('not writeable');
            throw new Error(`File ${symlinkPath} is not writeable. Cannot create extensionless symlink.`, err);
        }
    }

    await fse.symlink(fileName, symlinkPath);
    return symlinkPath;
}

function gitAddCommand(paths) {
    return `git add ${paths.join(' ')}`;
}

async function materializeSchemaVersion(schemaPath, schema = undefined, options = {}) {
    _.defaults(options, defaultOptions);
    const log = options.log;
    const schemaDirectory = path.dirname(schemaPath);

    // If schema not provided, then read it from schemaPath.
    if (!schema) {
        try {
            schema = await readSchemaFile(schemaPath);
        } catch (err) {
            throw new Error(`Failed reading schema from ${schemaPath}`, err);
        }
    }

    const version = schemaVersion(schema, options.schemaVersionField);

    // TODO: deference and validate schema here.
    const materializedSchemaPath = path.join(
        schemaDirectory, `${version}.${options.contentType}`
    );

    let newFiles = [];
    if (!options.dryRun) {
        await writeSchemaFile(schema, materializedSchemaPath, options);
        log.info(`Materialized ${schemaPath} at ${materializedSchemaPath}.`);
        newFiles.push(materializedSchemaPath);
    }
    else {
        log.info(`--dry-run: Would have materialized ${schemaPath} at ${materializedSchemaPath}.`);
    }

    if (options.shouldSymlink) {
        const symlinkPath = extensionlessPath(materializedSchemaPath);
        if (!options.dryRun) {
            await createSymlink(materializedSchemaPath, symlinkPath);
            log.info(
                `Created extensionless symlink ${symlinkPath} -> ${materializedSchemaPath}.`
            );
            newFiles.push(symlinkPath);
        } else {
            log.info(
                `--dry-run: Would have created extensionless symlink ${symlinkPath} -> ${materializedSchemaPath}.`
            );
        }
    }

    if (options.shouldGitAdd && !options.dryRun) {
        console.error(`New schema files have been generated. Please run:\n${gitAddCommand(newFiles)}`);
    }

    return materializedSchemaPath;
}




async function main(argv) {
    const args = neodoc.run(parsedUsage, argv);
    // console.log(args);

    const options = {
        contentType: args['--content-type'],
        schemaVersionField: args['--version-field'],
        shouldGitAdd: !args['--no-git-add'],
        shouldSymlink: !args['--no-symlink'],
        dryRun: args['--dry-run'],
        log: defaultOptions.log,
    };

    if (args['--verbose']) {
        options.log.level = 'debug';
    }

    const schemaPath = args['<schema-path>'];

    let schema = undefined;
    if (args['-']) {
        options.log.info('Reading schema from stdin');
        schema = objectFactory(fse.readFileSync(0, 'utf-8'));
    }

    try {
        return await materializeSchemaVersion(schemaPath, schema, options);
    } catch (err) {
        options.log.fatal(`Failed materializing schema at ${schemaPath}.`, err);
        // TODO: why is this not working?!
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main(process.argv);
}




module.exports = materializeSchemaVersion;
