
const RETRY_INTERVAL = 120000;
const CLEANUP_INTERVAL = 240000;
const CLEANUP_STALE_ENTRIES_THRESHOLD = 3600000;
          // 1 hr - no contact longer than that, it's a dead entry

const LOOP_BURST_COUNT = 100;
          // run through this many disqualifications in loops

let connections = {};
let cleanupTimerID = -1;
let DEFAULT_PREFIX = '/sse/';

let verbose = false;

function log(str) {
  if (verbose) {
    console.log('SSE: ' + str);
  }
}

///////////////////////////////////////////////////////////////////
//
// beg sse funcs (attached to res)
//
///////////////////////////////////////////////////////////////////
function sseHandler(req, res, next) {
  res.sseSetup = function(close) {
    let rspCode = close? 404 : 200;  // this isn't working on Chrome
    let contentType = close? 'text/plaintext' : 'text/event-stream';
    res.writeHead(rspCode, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
  }

  res.sseSend = function(retryInterval, data) {
    let msg = '';
//    if (retryInterval !== 0)   // chrome is ignoring this...
//      msg = "retry:" + retryInterval + "\n";

    msg += "data:" + JSON.stringify(data) + "\n\n";
    res.write(msg);
  }

  next();
}


//////////////////////////////////////////////////////////////////////
//
// end sse funcs
// beg async loop funcs
//
/////////////////////////////////////////////////////////////////////

function asyncNotifyListeners(listenKey) {
  log('ServerEventMgr:in asyncNotifyListeners, listenKey: ' + listenKey);
  return new Promise(function(acc, rej) {
    let sseKeys = Object.keys(connections);
            // work on a copy of keys

    if (sseKeys.length === 0)
      acc(true);

    else {
      function notifyListeners(ix) {
        let burstIX = 0;
        let thisKey;
        do {
          if (ix >= sseKeys.length) {
            acc(true);
            return;
                    // done
          }

          thisKey = sseKeys[ix++];

          if (thisKey in connections) {
                      // check the live connection -
                      // may have been deleted

            let sseRsp = connections[thisKey];
            let duration = Date.now() - sseRsp['registered-ts'];

            if (!('taskid' in sseRsp) &&
                 duration <= CLEANUP_STALE_ENTRIES_THRESHOLD) {
                      // filter out:
                      //  - anything that has a taskid -- 
                      //    that's sent on completion.
                      //  - stale entries

              sseRsp.notifyRes.sseSend(RETRY_INTERVAL,
                                       'notify^' + listenKey);
              break;
            }
          }
        } while (++burstIX < LOOP_BURST_COUNT);

        setImmediate(notifyListeners.bind(null, ix));
                  // 
      }

      notifyListeners(0);
    }
  });
}

function asyncCleanupRegistered(changedFilterKey) {
  return new Promise(function(acc, rej) {
    log('in asyncCleanupRegistered');
    let idKeys = Object.keys(connections);
                    // pull a copy of the keys
    let cleaned = false;

    if (idKeys.length === 0) {
      log(' --> no connections (no keys)')
      acc(true); // nothing to do
    }
    else {
      function cleanupRegistered(ix) {
        let idKey, burstIX = 0;

        do {
                // loop through the keys

          if (ix >= idKeys.length) {
            acc(true);
            return;
                  // done
          }

          idKey = idKeys[ix++];
          if ((idKey in connections)) {
            let sseRsp = connections[idKey];
            let duration = Date.now() - sseRsp['registered-ts'];
            log(' --> duration for id: ' + idKey + ', registered-ts: ' +
                        sseRsp['registered-ts'] + ' = ' +
                        duration/1000);

            if (duration > CLEANUP_STALE_ENTRIES_THRESHOLD) {
              log(' --> removing: ' + idKey + ' from connections');
              delete connections[idKey];
              cleaned = true;
                          // thpthpthp - gone.
              break;
            }
          }
                  // else loop around for the next
        } while (++burstIX < LOOP_BURST_COUNT);
        
        setImmediate(cleanupRegistered.bind(null, ix));
                  // trigger the next iteration
      }

      cleanupRegistered(0);
                    // initial call

      if (cleaned && changedFilterKey)
        asyncNotifyListeners(changedFilterKey);
    }
  });
}

function startCleanupInterval(changedFilterKey) {
  log('ServerEvent:startCleanupInterval');
  function doCleanup() {
    cleanupTimerID = setTimeout(function() {
      clearTimeout(cleanupTimerID);
      cleanupTimerID = 0;
      asyncCleanupRegistered(changedFilterKey)
      .then(function(rsp){
        if (Object.keys(connections).length === 0)
          stopCleanupInterval();
        else {
          console.assert(cleanupTimerID === 0, 'cleanup timer id should be 0');
          setImmediate(doCleanup);
        }
      })
    }, CLEANUP_INTERVAL);
  }

  if (cleanupTimerID === -1)
    doCleanup();
}

function stopCleanupInterval() {
  if (cleanupTimerID > 0) {
    clearTimeout(cleanupTimerID);
    cleanupTimerID = -1;
  }
}
//////////////////////////////////////////////////////////////////
//
// end async loop funcs
// beg ServerEvent object
//
///////////////////////////////////////////////////////////////////

let ServerEventMgr = {
  prefix: DEFAULT_PREFIX,
  createRouter(_prefix) {
    let express = require('express');
    let serverEventRouter = express.Router();
    let listenersChangedKey = '';

    if (_prefix !== undefined)
      this.prefix = _prefix;

    serverEventRouter.use(sseHandler);

    serverEventRouter.get(this.prefix + 'list-registrants', function(req, res) {
      res.send(ServerEventMgr.getListenersJSON());
    });
    
    serverEventRouter.get(this.prefix + 'clear-registrants', async function(req, res) {
      await ServerEventMgr.unregisterAllListeners();
      res.send("ok");
    });
    
    serverEventRouter.get(this.prefix + 'make-id/:name', function(req,res) {
      let id = ServerEventMgr.getUniqueID(req.params.name);
      res.send(id);
    });
    
    /**
     * register a listener
     */
    serverEventRouter.get(this.prefix + 'register-listener/:id', function(req, res) {
      let id = req.params.id;
      ServerEventMgr.registerListener(id, res);
              // res delegated to the ServerEventMgr -- 
              // don't respond here.
    });
    
    serverEventRouter.get(this.prefix + 'disconnect-registrant/:id', function(req,res){
      log('ServerEventMgr:disconnect-rgistrant, id: ' + req.params.id);
      ServerEventMgr.unregisterListener(req.params.id);
      res.send('ok');
    });

    serverEventRouter.get(this.prefix + 'trigger-ad-hoc/:id', function(req, res) {
      ServerEventMgr.triggerAdHocResponse(req.params.id);
      res.send('ok');
    });

    serverEventRouter.get(this.prefix + 'trigger-cleanup', function(req, res){
      ServerEventMgr.triggerCleanup();
      res.send('ok');
    });

    return serverEventRouter;
  },
  unregisterAllListeners() {
    stopCleanupInterval();
    connections = {};
  },
  setVerbose(flag) {
    verbose = flag;
  },
  notifyListeners(filterKeys) {
    asyncNotifyListeners(filterKeys);
  },
  getUniqueID(name) {
    let id = '';
  
    log('server in make-id: ' + name);
    
    do {
      id = [name, Math.random().toString(36).substring(7)].join('_');
    } while (id in connections);

    return id;
  },
  registerListener(id, res) {
    let resObj = {
      notifyRes: res,
      'registered-ts': Date.now()
    };

    log('in register-listener, id: ' + id);

    res.sseSetup();
    res.sseSend(RETRY_INTERVAL, "registered^" + id);
    connections[id] = resObj;
    if (this.listenersChangedKey)
      this.notifyListeners(this.listenersChangedKey);
    if  (Object.keys(connections).length === 1)
      startCleanupInterval(this.listenersChangedKey);
  },
  isRegistered(id) {
    return(id in connections);
  },
  unregisterListener(id) {
    if (id in connections)
      delete connections[id];
    if (Object.keys(connections).length === 0)
      stopCleanupInterval();
    if (this.listenersChangedKey)
      this.notifyListeners(this.listenersChangedKey);
  },
  getListenersJSON() {
    let idKeys = Object.keys(connections);
    let rspData = {}, tmpObj;
    
    for (let ix = 0; ix < idKeys.length; ++ix) {
      let idKey = idKeys[ix];

      if (connections[idKey] && connections[idKey]['registered-ts'] !== 0) {
        tmpObj = Object.assign({}, connections[idKey]);
        delete tmpObj.notifyRes;
        rspData[idKey] = tmpObj;
      }
    }

    return JSON.stringify(rspData);
  },
  triggerAdHocResponse(idKey) {
            // for debugging
    if (idKey in connections)
      connections[idKey].notifyRes.sseSend(0, "ad-hoc");
  },
  triggerCleanup() {
    stopCleanupInterval();
    asyncCleanupRegistered();
    startCleanupInterval();
  },
  notifyCompletions(id, taskid) {
    let name = id.split('_')[0];
    return new Promise(function(acc, rej) {
      let idKeys = Object.keys(connections);
                // get a current snapshot of the keys
  
      if (idKeys.length === 0)
        acc(true);
  
      else {
        function _notifyCompletions(ix) {
          if (ix >= idKeys.length)
            acc(true);
  
          else {
            let idKey = idKeys[ix];
            if ((idKey in connections) && idKey.startsWith(name)) {
              connections[idKey].notifyRes.sseSend(RETRY_INTERVAL, "completed^" +
                JSON.stringify({"timestamp": Date.now(), "id":idKey,
                                "taskid":taskid}));
                      // notify target listeners for specific event
            }
            
            setImmediate(_notifyCompletions.bind(null, ++ix));
          }
        }
        
        _notifyCompletions(0);
      }
    })
  }
};

module.exports = ServerEventMgr;