#!/usr/bin/env node

/**
 * This is the bulk of the processing logic for the IPFS git remote. The executable is
 * a driver for this code. The separation is to allow other drivers such as the
 * ipfs+mam driver which uses IOTA to track updates to the repository.
 */

/**
 * "Remote helper programs are invoked with one or (optionally) two arguments. The first
 *  argument specifies a remote repository as in Git; it is either the name of a
 *  configured remote or a URL. The second argument specifies a URL; it is usually of
 *  the form <transport>://<address>."
 *                             – https://git-scm.com/docs/gitremote-helpers#_invocation
 */
if(process.argv.length < 2) {
  console.error('Usage: git-remote-ipfs remote-name url')
  process.exit(-10)
}

const Git = require('nodegit')
const IPFSProxy = require('ipfs-http-client')
const all = require('it-all')
const toBuffer = require('it-to-buffer')
const { Console } = require('console');
const { v1:uuidv1 } = require('uuid');

const EMPTY_REPO_CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
const DEBUG = !!process.env.DEBUG

const console = new Console(process.stderr)

module.exports = class {
  constructor({ ipfs, cache, repo, url, meta = {} }) {
    this.ipfs = ipfs
    this.repo = repo
    this.cache = cache
    this.url = url
    this.vfs = meta

    /**
     * When pushing a commit, a merge can cause the same object
     * id to be processed multiple times. This class does a lookup
     * for the first occurrence and defers subsequent requests
     * until the first occurrence returns.
     */
    this.oidMgr = {
      resolvers: {},
      convert: (oid) => {
        if(!this.oidMgr.resolvers[oid]) { // new
          this.pushCommit(oid)
          this.oidMgr.resolvers[oid] = []
        }
        const promise = new Promise((res, rej) => {
          this.oidMgr.resolvers[oid].push(res)
        })
        return promise
      },
      cidFound: (oid, cid) => {
        if(this.oidMgr.resolvers[oid]) {
          while(this.oidMgr.resolvers[oid].length > 0) {
            this.oidMgr.resolvers[oid].pop().call(this, cid)
          }
        }
      }
    }

    /**
     * The same functionality as oidMgr, but for content ids to
     * be used in fetching.
     */
    this.cidMgr = {
      resolvers: {},
      convert: (cid) => {
        if(!this.cidMgr.resolvers[cid]) { // new
          this.fetchCommit(cid)
          this.cidMgr.resolvers[cid] = []
        }
        const promise = new Promise(async (res, rej) => {
          const oid = await this.cache.get(cid)
          if(oid) {
            res.call(this, Git.Oid.fromString(oid.toString()))
          } else {
            this.cidMgr.resolvers[cid].push(res)
          }
        })
        return promise
      },
      oidFound: (cid, oid) => {
        this.cache.put(cid, oid)
        .then(() => {
          if(this.cidMgr.resolvers[cid]) {
            oid = Git.Oid.fromString(oid.toString())
            while(this.cidMgr.resolvers[cid].length > 0) {
              this.cidMgr.resolvers[cid].pop().call(this, oid)
            }
          }
        })
      }
    }
  }

  /**
   * Setup function to handle asynchronous setup operations not
   * permitted in the constructor.
   */
  async create() {
    if(this.url) {
      if(this.url.startsWith('ipfs://')) {
        const name = this.url.replace(/^ipfs:\/\//, '')
        if(name) {
          this.vfs.name = name
        }
      } else if(this.url.length > 0) {
        this.vfs = Object.assign(
          (await this.ipfs.dag.get(`${this.url}/.git/`)).value, this.vfs
        )
        DEBUG && console.debug('Continuing:', this.url)
      }
    }
    
    this.odb = await this.repo.odb()

    return this
  }

  /**
   * Create an object representing a signature from nodegit.
   *
   * @param sig: the nodegit signature
   */
  objForSig(sig) {
    return {
      name: sig.name(), email: sig.email(),
      time: sig.when().time(), offset: sig.when().offset()
    }
  }

  /**
   * Create a nodegit signature for an object returned from `objForSig`.
   */
  sigForObj(obj) {
    return Git.Signature.create(obj.name, obj.email, obj.time, obj.offset)
  }

  /**
   * Is the given object id present in the object database?
   *
   * @param oid: object id to check
   */
  async oidInODB(oid) {
    try {
      return await this.odb.existsPrefix(oid, oid.length)
    } catch(err) {
      return false
    }
  }

  /**
   * Create a listing of reference values for the `.git/refs` entry of
   * the repository for the `list` command of git.
   *
   * @param root: the base object to traverse looking for commits
   * @param path: the current path from the root – expanded as the object is traversed
   */
  async serializeRefs(root, path = 'refs') {
    await Promise.all(Object.entries(root).map(async ([name, obj]) => {
      if(obj instanceof IPFSProxy.CID || obj.codec == 'dag-cbor') {
        const commit = (await this.ipfs.dag.get(obj)).value
        DEBUG && console.debug(`> ${commit.oid} ${path}/${name}`)
        process.stdout.write(`${commit.oid} ${path}/${name}\n`)
      } else {
        await this.serializeRefs(obj, `${path}/${name}`)
      }
    }))
  }

  /**
   * Retrieve the given UnixFS-Protobuf tree to the git object
   * database using the DAG at `modesCID` for the file modes.
   *
   * @param root: the IPFS CID of the filesystem
   * @param modesCID: the CID of a CBOR-DAG with the file mode information
   */
  async fetchTree(root, modesCID) {
    DEBUG && console.debug('fetchTree()', root.toString())
    const list = await all(this.ipfs.ls(root.toString()))
    const tb = await Git.Treebuilder.create(this.repo, null)
    const modes = (await this.ipfs.dag.get(modesCID)).value

    await Promise.all(list.map(async ({ name, cid, type }) => {
      if(type === 'dir') {
        let oid = await this.cache.get(cid)
        if(!oid || !(await this.oidInODB(oid.toString()))) {
          oid = await this.fetchTree(cid, modes[name])
          await this.cache.put(cid, oid)
        }
        tb.insert(name, oid.toString(), Git.TreeEntry.FILEMODE.TREE)
      } else {
        let oid = await this.cache.get(cid)
        if(!oid || !(await this.oidInODB(oid.toString()))) {
          const buffer = await toBuffer(this.ipfs.cat(cid))
          oid = await Git.Blob.createFromBuffer(this.repo, buffer, buffer.length)
          await this.cache.put(cid, oid) // if not awaited, the cache can close before this executes
        }
        tb.insert(name, oid.toString(), modes[name])
      }
    }))
    .catch(console.error)

    const oid = await tb.write()
    return oid
  }

  /**
   * Retrieve a tag from IPFS and write it (and the associated commit tree)
   * to the git object database.
   *
   * @param cid: IPFS content id of the tag object
   */
  async fetchTag(cid) {
    DEBUG && console.debug('fetchTag()', cid)
    const root = (await this.ipfs.dag.get(cid)).value
    const {
      name, type, commit: commitCID, message, taggerSig, signature,
    } = root
    const commit = await this.cidMgr.convert(commitCID)
    const force = true ? 1 : 0
    let tag
    if(type === 'annotated') {
      const tagger = this.sigForObj(taggerSig)
      if(signature) {
        console.debug(`Creating w/ sig: ${name} (${commit})`)
        const sign = (tag) => ({
          code: Git.Error.CODE.OK,
          signedData: signature,
        })
        tag = await Git.Tag.createWithSignature(
          this.repo, name, commit, tagger, message, force, sign
        )
      } else {
        console.debug(`Creating w/o sig: ${name}`)
        tag = await Git.Tag.create(
          this.repo, name, commit, tagger, message, force
        )
      }
    } else {
      console.debug(`Creating lightweight: ${name}`)
      tag = await Git.Tag.createLightweight(
        this.repo, name, commit, force
      )
    }
    DEBUG && console.debug(`TAG: ${tag}`)
    return tag
  }

  /**
   * Retrieve a commit (and its parents, and their parents…) from IPFS
   * and insert them and their associated trees into the git object
   * database.
   *
   * @param cid: the IPSF content id of the commit CBOR-DAG
   */
  async fetchCommit(cid) {
    DEBUG && console.debug('fetchCommit()', cid)
    const root = (await this.ipfs.dag.get(cid)).value
    const {
      authorSig, committerSig, encoding, message, oid,
      tree:treeCID, modes, parents:parentCIDs, signature,
    } = root
    const treeOID = await this.fetchTree(treeCID, modes)
    const tree = await Git.Tree.lookup(this.repo, treeOID)
    const parents = await Promise.all(parentCIDs.map(
      async c => {
        const oid = await this.cidMgr.convert(c)
        const commit = await Git.Commit.lookup(this.repo, oid)
        return commit
      }
    ))
    const parent_count = parents.length
    const author = this.sigForObj(authorSig)
    const committer = this.sigForObj(committerSig)

    let commit
    if(signature) {
      const buffer = await Git.Commit.createBuffer(
        this.repo, author, committer, encoding, message, tree, parent_count, parents
      )
      commit = await Git.Commit.createWithSignature(
        this.repo, buffer.toString(), signature, 'gpgsig'
      )
    } else {
      commit = await Git.Commit.create(
        this.repo, null, author, committer, encoding, message, tree, parent_count, parents
      )
    }
    process.stderr.write(`Commit: ${commit}/${oid} (${cid})\n`)
    process.stderr.write(`Tree OID: ${treeOID} (${treeCID})\n`)
    this.cidMgr.oidFound(cid, oid)
    return commit
  }

  /**
   * Insert a nodegit tree into IPFS as a UnixFS-Protobuf and nested CBOR-DAG
   * with the file mode information. Both are returned: [filesystemCID, modesCID]
   *
   * @param tree: nodegit tree to insert
   * @param base: IPFS CID to build filesystem off of. By default this is an
   *               empty directory tree.
   */
  async pushTree(tree, base = EMPTY_REPO_CID) {
    DEBUG && console.debug('pushTree()', tree.id().toString())
    var modes = {}
    for(const e of (await tree.entries())) {
      let cid = await this.cache.get(e.oid())
      if(e.isTree()) {
        let childModes = await this.cache.get(`modes:${e.oid()}`)
        if(childModes) {
          childModes = new IPFSProxy.CID(childModes.toString())
        }
        if(!cid || !childModes) {
          DEBUG && console.debug('Cache Miss', e.oid().toString())
          ;[cid, childModes] = await this.pushTree(await e.getTree())
          await this.cache.put(e.oid().toString(), cid)
          await this.cache.put(`modes:${e.oid().toString()}`, childModes.toString())
          DEBUG && console.debug('CID', cid, childModes)
        }
        modes[e.name()] = childModes
      } else if(e.filemode().toString(8)[0] === '1') { // e.isBlob() is false for links
        if(!cid) {
          const content = (await e.getBlob()).content()
          const progress = (len) => process.stderr.write(`len:${len}\n`)

          DEBUG && console.debug('Adding', e.name())

          cid = (await all(this.ipfs.add({ content: content, progress: progress, pin: true })))[0].cid
          await this.cache.put(e.oid(), cid)
        }
        modes[e.name()] = e.filemode()
      } else {
        console.warn(`Neither Blob nor Tree TreeEntry: ${e.oid()} (${e.filemode().toString(8)})`)
        continue
      }
      DEBUG && console.debug('Patching', e.name(), cid.toString())
      base = await this.ipfs.object.patch.addLink(
        base, { name: e.name(), cid: cid }, { pin: true }
      )
    }
    return [base, await this.ipfs.dag.put(modes, { pin: true })]
  }

  async pushCommit(oid) {
    DEBUG && console.debug('pushCommit()', oid.toString())
    process.stderr.write(`mit:${oid}: `)
    let cid = await this.cache.get(oid)
    if(cid) {
      cid = new IPFSProxy.CID(cid.toString())
      process.stderr.write(`cache:${cid}\n`)
    } else {
      const head = await Git.Commit.lookup(this.repo, oid)
      const [tree, modes] = await this.pushTree(await head.getTree())
      process.stderr.write(`tree:${tree}\n`) // \r\x1b[A
      const parents = await Promise.all(
        (await head.parents()).map(p => this.oidMgr.convert(p))
      )
      const obj = {
        authorSig: this.objForSig(head.author()),
        committerSig: this.objForSig(head.committer()),
        encoding: head.messageEncoding(), message: head.message(),
        parents: parents, tree: new IPFSProxy.CID(tree), modes: modes,
        oid: oid.toString(),
      }
      try {
        obj.signature = await head.headerField('gpgsig')
      } catch(err) { /* No signature */ }
      cid = await this.ipfs.dag.put(obj, { pin: true })
      await this.cache.put(oid.toString(), cid)
    }
    this.oidMgr.cidFound(oid, cid)
    return cid
  }

  async pushTag(oid, name) {
    DEBUG && console.debug('pushTag()', oid.toString())
    let obj
    try {
      const tag = await Git.Tag.lookup(this.repo, oid)
      process.stderr.write(`tag:${oid}: `)
      const commit = await this.pushCommit(tag.targetId())

      let message = tag.message(), signature
      const lines = message.split(/\r?\n/)
      const startIdx = lines.findIndex(
        (l) => l === '-----BEGIN PGP SIGNATURE-----'
      )
      if(startIdx >= 0) {
        message = lines.slice(0, startIdx).join("\n")
        signature = lines.slice(startIdx).join("\n")
      }

      obj = {
        commit: commit, taggerSig: this.objForSig(tag.tagger()),
        name: name, message: message, type: 'annotated',
        oid: oid.toString(),
      }

      if(signature) {
        obj.signature = signature
      }
    } catch(err) { // Lightweight tags return a commit instead of a tag
      if(err.errno === -3 && err.errorFunction === 'Tag.lookup') {
        const commit = await this.pushCommit(oid)
        obj = {
          name: name, commit: commit, type: 'lightweight', oid: oid.toString(),
        }
      } else {
        throw err
      }
    }
    return await this.ipfs.dag.put(obj, { pin: true })
  }

  async doFetch(fetchRefs) {
    for(const [hash, ref] of [...new Set(fetchRefs)]) {
      DEBUG && console.debug('doFetch()', `${process.argv[3]}/.git/${ref}`)
      try {
        if(ref.startsWith('refs/tags')) {
          const tag = await this.fetchTag(`${process.argv[3]}/.git/${ref}`)
        } else {
          const commit = await this.fetchCommit(`${process.argv[3]}/.git/${ref}`)
          await this.repo.createBranch(ref.replace(/^refs\/heads\//, ''), commit)
          console.debug(`Created Branch: ${ref.replace(/^refs\/heads\//, '')}`)
        }
      } catch(err) {
        if(err.errno === -4 && err.errorFunction === 'Branch.create') {
          // branch already exists
        } else {
          console.error(err)
        }
      }
    }
    const refs = await this.repo.getReferences()
    console.debug(refs.map(r => r.toString()))
    const HEAD = (await this.ipfs.dag.get(`${process.argv[3]}/.git/HEAD`)).value
    DEBUG && console.debug(`Setting HEAD: ${HEAD}`)
    await this.repo.setHead(`${HEAD}`)
  }

  async doPush(pushRefs) {
    let base

    // Unset so it will be set to the commit that was just pushed
    this.vfs.HEAD = undefined

    while(pushRefs.length > 0) {
      const [src, dst] = pushRefs.shift()

      DEBUG && console.debug('doPush', src, dst)

      try {
        const oid = await Git.Reference.nameToId(this.repo, src)
        const isTag = dst.split('/')[1] === 'tags'
        DEBUG && console.debug('Starting w/ OID', oid.toString(), `(${src})`)
        const cid = await (isTag
          ? this.pushTag(oid, dst.split('/').slice(2).join('/'))
          : this.pushCommit(oid)
        )

        const parts = dst.split('/')
        const last = parts.slice(0, parts.length - 1).reduce((obj, step) => {
          return obj[step] = obj[step] || {}
        }, this.vfs)
        last[parts.slice(-1)[0]] = cid

        base = base || ((await this.ipfs.dag.get(`${cid}${isTag ? '/commit' : ''}`)).value).tree
        this.vfs.HEAD = this.vfs.HEAD || dst

        DEBUG && console.debug(`> ok ${dst}`)
        process.stdout.write(`ok ${dst}\n`)
      } catch(e) {
        console.error(e)
      }
    }

    this.vfs.uuid = this.vfs.uuid || uuidv1()

    const cid = await this.ipfs.object.patch.addLink(
      base,
      { name: '.git', cid: await this.ipfs.dag.put(this.vfs, { pin: true }) },
      { create: true, pin: true }
    )
    await this.ipfs.pin.add(cid)

    return cid
  }
}