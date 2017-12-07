const express = require('express')
const bodyParser = require('body-parser')
const socketIO = require('socket.io')
const MongoClient = require('mongodb').MongoClient
const path = require('path')
const assert = require('assert')
const _ = require('lodash')
const kmeans = require('node-kmeans')
const uuid = require('uuid')

const discord = require('./app/discordbot.js')
const enemyAI = require('./app/modules/enemyAI.js')

const PORT = process.env.PORT || 5000
const INDEX = path.join(__dirname, 'index.html')
const MONGO_URI = process.env.MONGODB_URI

const PI_FLOAT = 3.14159265
const PIBY2_FLOAT = 1.5707963

const server = express()
  .use((req, res) => res.sendFile(INDEX))
  .listen(PORT, () => console.log(`Listening on ${PORT}`))

const io = socketIO(server)
var clients = []
var enemies = []
var updates = []
var clusters = []
var database
var ready = false
var knum = 1

// Used for k-means points
for (var i = 0; i < knum; i++) {
  var fakes = {
    name: 'kmeans point: ' + (i + 1),
    positionx: (Math.random() * 1000),
    positiony: (Math.random() * 1000),
    socket: null,
    room: 'start'
  }
  clients.push(fakes)
}

MongoClient.connect(MONGO_URI, (err, db) => {
  assert.equal(null, err)
  console.log('Connected to mongo')
  database = db
  ready = true
})

io.on('connect', (socket) => {

  var playerName = null // Global for each socket connection

  /** PING */
  socket.on('test', () => {
    console.log(`[RECV - New connection] : ${socket}`)
  })

  /** NETWORK MENU */
  socket.on('player-reg', (name, email, pass) => {
    var newUser = {
      name,
      email,
      pass,
      reg: false,
    }
    var newMovements = {
      name,
      positionx: 1297.0,
      positiony: -1125,
    }

    console.log('[RECV - Regsiter] : ' + newUser)
    var users = database.collection('users')
    var movements = database.collection('movements')

    users.findOne({
      $or: [{
        name: name
      }, {
        email: email
      }]
    }, (err, doc) => {
      if (err) {
        socket.emit('player-menu', 'err')
      } else if (doc) {
        socket.emit('player-menu', 'dub')
      } else {
        users.insertOne(newUser, (err, res) => {
          movements.insertOne(newMovements, (err, res) => {
            if (err) {
              socket.emit('player-menu', 'err')
            } else {
              socket.emit('player-menu', 'good')
            }
          })
        })
      }
    })
  })

  socket.on('player-login', (name) => {
    var pass = true
    _.forEach(clients, client => {
      if (name == client.name) {
        pass = false
        socket.emit('player-menu', 'log')
      }
    })
    console.log('[RECV - Login] : ' + name)
    if (pass) {
      var users = database.collection('users')
      users.findOne({
        name: name
      }, (err, doc) => {
        if (err) {
          socket.emit('player-menu', 'err')
        } else if (doc) {
          socket.emit('player-menu', doc.pass)
          playerName = name
        } else {
          socket.emit('player-menu', 'not')
        }
      })
    }
  })

  socket.on('menu-disconnect', () => {
    socket.disconnect('true')
  })

  /** NETWORK PLAY */
  if (playerName) {
    socket.on('start-up', (name) => {
      console.log('[RECV - Spawn player] : ' + name)
      playerName = name
      var movements = database.collection('movements')
      movements.findOne({
        name: name,
      }, (err, doc) => {
        if (err) {
          console.log('[ERROR - No login]:  ' + err)
        } else {

          var client = {
            name: doc.name,
            health: 0,
            positionx: doc.positionx,
            positiony: doc.positiony,
            socket: socket,
            room: 'start'
          }

          // SETUP YOUR PLAYER
          socket.emit('start-up',
            client.name,
            client.health,
            client.positionx,
            client.positiony,
          )

          socket.join('start')
          clients.push(client)
        }
      })
    })

    socket.on('player-move', (name, positionx, positiony, playerMoving, moveH, moveV, lastmovex, lastmovey, targetable, area) => {
      //console.log('[RECV - Player move] : ' + name)
      var client = _.find(clients, { name: name })

      if (client) {
        client.name = name
        client.positionx = positionx
        client.positiony = positiony

        io.in(client.room).emit('player-move',
          name,
          positionx,
          positiony,
          playerMoving,
          moveH,
          moveV,
          lastmovex,
          lastmovey
        )
      }

      socket.emit('ack-move')
    })

    socket.on('player-message', (name, message) => {
      console.log('[RECV - Message] ' + name + ': ' + message)
      socket.broadcast.emit('player-message', name, message)
      socket.emit('player-message', name, message);
    })

    socket.on('player-attack', (name, attacking) => {
      //console.log('[RECV - Attack] ' + name + ': ' + attacking)
      var client = _.find(clients, { name: name })
      if (client) {
        io.in(client.room).emit('player-attack', name, attacking)
      }
    })
  }

  /** SOCKET HANDLERS */
  socket.on('connecting', () => {
    console.log(`[RECV - New connection] : ${socket}`)
  })

  socket.on('disconnect', (reason) => {
    console.log(`[RECV - Player disconnected] : ${playerName} : ${reason}`)
    socket.broadcast.emit('other-player-disconnected', playerName)
    _.remove(clients, { name: playerName })
  })

  socket.on('error', (error) => {
    console.log(`[RECV - Server error] : ${playerName} : ${error}`)
  })

})

var counter = 0
setInterval(() => {
  if (ready) {
    io.emit('time', new Date().toTimeString())
    enemyUpdate()

    if (counter == 100) {
      setDatabase()
      console.log(enemies)
      //getCluster()
      //var allRooms = _.map(clients, 'room')
      //console.log(_.uniq(allRooms))
      counter = 0
    }
    counter++
  }
}, 100)

function getCluster() {
  let vectors = new Array()
  for (let i = 0; i < clients.length; i++) {
    vectors[i] = [clients[i].positionx, clients[i].positiony]
  }
  kmeans.clusterize(vectors, {
    k: knum
  }, (err, res) => {
    if (err) console.error(err)
    //else console.log(res)
    clusters = res
    _.forEach(clusters, cluster => {
      for (var i = 0; i < cluster.clusterInd.length; i++) {
        var client = _.find(clients, {
          name: clients[cluster.clusterInd[i]].name,
        })
        if (client.socket) {
          client.socket.leaveAll()
          client.socket.join(cluster.centroid.toString())
          client.room = cluster.centroid.toString()
        }
      }
    })
  })
}

function setDatabase() {
  var movements = database.collection('movements')
  _.forEach(clients, client => {
    if (!_.includes(client.name, 'kmeans')) {
      movements.update({
        name: client.name,
      }, {
          name: client.name,
          positionx: client.positionx,
          positiony: client.positiony,
        }, (err, res) => {
          if (err) {
            console.log(`[SERVER - Error]: ${err}`)
          } else {
            console.log(`[RECV - Update database]: ${client.name}`)
          }
        })
    }
  })
}

function enemyUpdate() {
  if (enemies.length < 10) {
    currentEnemy = {
      name: uuid.v1(),
      positionx: 1452,
      positiony: -1433,
      health: 100,
      target: ''
    }
    enemies.push(currentEnemy)
    console.log(`[SERVER - Spawn Enemy] : ${currentEnemy.name}`)
  }

  // Enemy AI
  var enemy = enemies[counter % enemies.length]
  if (Math.random() >= 0.25) {
    if (enemy.target == '') {
      var client = clients[Math.floor(Math.random() * clients.length)]
      if (!_.includes(client.name, 'kmeans')) {
        var distance = enemyAI.getDistance(enemy.positionx, enemy.positiony, client.positionx, client.positiony)
        if (distance < 100) {
          enemy.target = client.name
        } else {
          enemy.target = ''
          var radian = Math.random() * (2 * Math.PI)
          enemy = enemyAI.checkMove(enemy, radian)
          //console.log(`[Server - Enemy random] : ${enemy.name} -> ${client.name}`)
          io.local.emit('enemy-move', enemy.name, enemy.positionx, enemy.positiony, enemy.target)
        }
      }
    }
    else {
      var client = _.find(clients, { name: enemy.target })
      if (client) {
        var distance = enemyAI.getDistance(enemy.positionx, enemy.positiony, client.positionx, client.positiony)
        if (distance > 200) {
          enemy.target = ''
        } else {
          enemy.target = client.name
          var radian = enemyAI.getRadian(enemy.positionx, enemy.positiony, client.positionx, client.positiony)
          enemy = enemyAI.checkMove(enemy, radian)
          //console.log(`[Server - Enemy target] : ${enemy.name} -> ${client.name}`)
          io.local.emit('enemy-move', enemy.name, enemy.positionx, enemy.positiony, enemy.target)
        }
      }
    }
  }
}
