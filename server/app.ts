global.Promise = require("bluebird")

import express = require('express');
import mime = require('mime');
import fs = require('fs');
import crypto = require("crypto")
import expander = require('./expander')
import gitlabfs = require('./gitlabfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import auth = require('./auth')


bluebird.longStackTraces()

var app = express();
var bodyParser = require('body-parser')

let fileLocks = tools.promiseQueue()

app.use(require('cookie-parser')());
app.use(require("compression")())
app.use(bodyParser.json({
    limit: 5 * 1024 * 1024
}))


auth.initCheck(app)

app.get('/', (req, res) => {
    res.redirect("/sample/index")
})

auth.initRoutes(app)

interface ImgData {
    page: string;
    full: string;
    thumb: string;
    filename: string;
    format: string;
}

app.post("/api/uploadimg", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let data = req.body as ImgData
    let pathElts = data.page.split(/\//).filter(s => !!s)
    pathElts.pop()
    pathElts.push("img")
    let path = pathElts.join("/")
    let fullPath = ""
    fileLocks(path, () =>
        gitlabfs.refreshAsync()
            .then(() => gitlabfs.getTreeAsync(path))
            .then(tree => {
                let buf = new Buffer(data.full, "base64")

                if (tree) {
                    let hash = gitlabfs.githash(buf)
                    let existing = tree.children.filter(e => e.id == hash)[0]
                    if (existing) {
                        fullPath = path + "/" + existing.name
                        return Promise.resolve()
                    }
                }

                let basename = data.filename
                    .replace(/.*[\/\\]/, "")
                    .toLowerCase()
                    .replace(/\.[a-z]+$/, "")
                    .replace(/[^\w\-]+/g, "_")
                let ext = "." + data.format
                let hasName = (n: string) =>
                    tree ? tree.children.some(f => f.name == n) : false
                let fn = basename + ext
                let cnt = 1
                while (hasName(fn)) {
                    fn = basename + "-" + cnt++ + ext
                }

                fullPath = path + "/" + fn
                return gitlabfs.setBinFileAsync(fullPath, buf, "Image " + fullPath + " by " + req.appuser)
            })
            .then(() => {
                res.json({
                    url: "/" + fullPath
                })
            }))
})

app.post("/api/update", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let fn = req.body.page.slice(1) + ".html"
    if (fn.indexOf("private") == 0)
        return res.status(402).end()
    fileLocks(fn, () =>
        gitlabfs.refreshAsync()
            .then(() => expander.expandFileAsync(fn))
            .then(page => {
                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                val = "\n" + val + "\n"
                val = val.replace(/\r/g, "")
                val = val.replace(/(^\n+)|(\n+$)/g, "\n")

                if (desc) {
                    let cont = page.allFiles[desc.filename]
                    let newCont = cont.slice(0, desc.startIdx) + val + cont.slice(desc.startIdx + desc.length)
                    gitlabfs.setTextFileAsync(desc.filename, newCont,
                        "Update " + desc.filename + " / " + id + " by " + req.appuser)
                        .then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }))
})

app.use("/gw", express.static("built/gw"))
app.use("/gw", express.static("gw"))
//app.use("/gw", express.static("node_modules/ContentTools/build"))
//app.use("/", express.static("html"))

app.get(/.*/, (req, res, next) => {
    let cleaned = req.path.replace(/\/+$/, "")
    if (cleaned != req.path) {
        return res.redirect(cleaned + req.url.slice(req.path.length + 1))
    }

    cleaned = cleaned.slice(1)

    if (cleaned.indexOf("private") == 0)
        return next()

    let spl = gitlabfs.splitName(cleaned)
    let isHtml = spl.name.indexOf(".") < 0

    if (isHtml) cleaned += ".html"
    gitlabfs.getBlobIdAsync(cleaned)
        .then(id => {
            if (!id) next()
            else if (isHtml)
                expander.expandFileAsync(cleaned)
                    .then(page => {
                        let html = page.html
                        if (req.appuser) {
                            html = html
                                .replace("<!-- @GITWED-EDIT@", "")
                                .replace("@GITWED-EDIT@ -->", "")
                        }
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf8'
                        })
                        res.end(html)
                    })
                    .then(v => v, next)
            else
                gitlabfs.fetchBlobAsync(id)
                    .then(buf => {
                        res.writeHead(200, {
                            'Content-Type': mime.lookup(cleaned),
                            'Content-Length': buf.length
                        })
                        res.end(buf)
                    })
        })
})

app.use((req, res) => {
    res.status(404).send('Page not found');
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.log(error.stack)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    if (req.appuser)
        res.end('Internal Server Error, ' + error.stack);
    else
        res.end('Internal Server Error');
})

let dataDir = process.argv[2]
let cfg: gitlabfs.Config = {} as any
if (fs.existsSync("config.json"))
    cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
else if (!dataDir) {
    console.log("need either config.json or data dir argument")
    process.exit(1)
}

if (dataDir) {
    console.log('Using local datadir: ' + dataDir)
    cfg.localRepo = dataDir
}

gitlabfs.initAsync(cfg)
    .then(() => {
        if (cfg.localRepo) app.listen(3000, "localhost")
        else app.listen(3000)
    })

//expander.test()