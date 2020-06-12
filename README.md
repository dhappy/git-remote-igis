# Interplanetary Filesystem (IPFS) Git Remote Helper

Push and fetch commits to IPFS. To use the IOTA tangle to distribute the most recent version of a repo, see [git-remote-ipfs+mam](https://github.com/dhappy/git-remote-ipfs-mam).

## Installation

1. Install [ipfs-desktop](//github.com/ipfs-shipyard/ipfs-desktop#install) or another IPFS daemon
2. `npm install --global git-remote-ipfs`

## Usage

#### (Insecure) Cloud Backup

1. `git push ipfs://projectname --tags # you can't push all and tags at the same time`
2. `git push ipfs::<CID from Step #1> --all`
3. Pin the resultant hash on a pinning service.

_Note that #2 uses the CID produced by #1. When a CID is provided for a push the push will add changes to that repository maintaining some information such as the name and uuid._

#### Push `master` with tags and get an IPFS CID back:

`git push --tags ipfs:: master`

#### Pull a commit:

`git pull ipfs::Qma5iwyvJqxzHqCT9aqyc7dxZXXGoDeSUyPYFqkCWGJw92`

#### Clone a repository:

`git clone ipfs::Qma5iwyvJqxzHqCT9aqyc7dxZXXGoDeSUyPYFqkCWGJw92 repo`

#### Create a repo named "myproject" and show debugging info:

`DEBUG=t git push ipfs://myproject`

## Overview

This remote serializes a Git commit tree to a CBOR-DAG stored in IPFS. The root of the generated filesystem is the branch that was last pushed.

## Generated File Structure

* `/`: the contents of the branch that was pushed
* `.git/`: CBOR-DAG representing a git repository
* `.git/HEAD`: string entry denoting the current default branch
* `.git/uuid`: UUIDv1 identifier that stays constant across pushes
* `.git/refs/(heads|tags)/*`: Pointers to commit objects

Each commit then has:

* `parents`: The commit's parent commits
* `(author|committer)`: The commits author and committer signatures
* `gpgsig`: Optional signature for the commit
* `tree`: The filesystem state at the time of this commit
* `modes`: `tree` is an IPFS Protobuffer-UnixFS DAG which is browsable through the web, but can't store the file mode information, so this is that info.

### IPLD Git Remote

Integrating Git and IPFS has been on ongoing work with several solutions over the years. The [predecessor to this one](//github.com/ipfs-shipyard/git-remote-ipld) stored the raw blocks in the IPFS DAG using a multihash version of git's SHA1s.

The SHA1 keys used by Git aren't exactly for the hash of the object. Each git object is prefaced with a header of the format: "`#{type} #{size}\x00`". So a Blob in Git is this header plus the file contents.

Because the IPLD remote stores the raw Git blocks, the file data is fully present, but unreadable because of the header.

## Troubleshooting

It is safe to delete `.git/remote-igis/cache/` though it will require regenerating all the commits which could take some time.

# License
[MIT](LISENCE)
