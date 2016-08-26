import express from 'express';
import serveStatic from 'serve-static';
import path from 'path';
import cookieParser from 'cookie-parser'
import passport from './passport/passport_github.js';
import jwt from 'jsonwebtoken';
import handleRender from './server-render/handle-render.js';
import bodyParser from 'body-parser';
import {Register,Login} from './local_Auth/localAuth.js'
import {skill_suggestions,skill_user} from './socketHandlers/skills.js'
import {category_suggestions} from './socketHandlers/category.js'
import {createNewProject,project_list,project_detail,join_project,update_last_activity,project_check_name,edit_project,get_more_messages} from './socketHandlers/project.js';
import {vote} from './socketHandlers/vote.js';
import {db,queries} from './config';
import user_profile_cleaner from './utils/user_profile_cleaner.js'
import notification from './socketHandlers/notifications.js'

export const run = (worker) => {
  console.log(' >> worker PID: ',process.pid);

  const app = express();

  const httpServer = worker.httpServer;
  const scServer = worker.scServer;

  //standard express fluff
  if(process.env.NODE_ENV.trim()==='development'){
    app.use(serveStatic(path.resolve(__dirname, '../public')));
  }
  app.use(cookieParser())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(passport.initialize())

  app.get('/auth/github',passport.authenticate('github'))

  // To-Do : Failure Redirect
  app.get('/auth/github/callback',passport.authenticate('github',{failureRedirect:'/fail'}),
    function(req,res){
      var text=  JSON.stringify(req.user.token)
      res.cookie('id_token',text,{ expires: new Date(Date.now() + (24 * 60 * 60 * 1000 * 30 * 12 * 10)), httpOnly: true })
      res.redirect('/')
    }
  )

  app.post('/auth/register',Register)
  app.post('/auth/login',Login)

  app.get('/logout',function(req,res){
    res.clearCookie('id_token');
    res.redirect('/')
  })

  // passport.js doesnt work without serializerUser and deserializeUser. Adding this for now.

  passport.serializeUser(function(user,done){
    // console.log('serializeUser returns : ',user)
    done(null,user)
  });

  passport.deserializeUser(function(user,done){
    // console.log('deserializeUser has: ',user)
    done(null,user)
  });

  app.use(handleRender)



  httpServer.on('request',app);

  scServer.on('connection',(socket) => {
    console.log('socket connected : ',socket.id)
    //what the above does is decode the socket cookie. decode the string > sets auth profile to socket.
    if(socket.request.headers.cookie){
      const cookie = decodeURIComponent(socket.request.headers.cookie)
      const id_token = JSON.parse(cookie.split('=')[1])
      const decoded = jwt.verify(id_token,process.env.JWT_SECRET)
      socket.setAuthToken({username:decoded.username})
    }


    socket.on('skill:suggestions',skill_suggestions)


    socket.on('skills:user',function(data,res){
      data.username = socket.getAuthToken().username;
      skill_user(data)
        .then(function(result){
          res(null,result)
        })
        .catch(function(err){
          console.log('errr: ',err)
          res(err)
        })
    })


    socket.on('category:suggestions',category_suggestions)

    socket.on('project:create',function(data,res){
      data.username = socket.getAuthToken().username;
      createNewProject(data)
        .then(function(details){
          console.log(details)
          res(null,details)
        })
        .catch(function(err){
          console.log(err)
          res(err)
        })
    })

    //Retrieves a list of projects
    socket.on('project:list',function(data,res){
      project_list(data)
        .then(function(result){
          res(null,result)
        })
        .catch(function(err){
          console.log(err)
          res(err)
        })
    })

    // socket.on('project:detail',project_detail)
    socket.on('project:detail',function(data,res){
      project_detail(data)
        .then(function(result){
          res(null,result)
        })
        .catch(function(err){
          res(err)
        })
    })

    // socket.on('project:join',join_project)
    socket.on('project:join',function(data,res){
      data.username = socket.getAuthToken().username
      join_project(data)
        .then(function(result){
          res(null,result)
        })
        .catch(function(err){
          res(err)
        })
    })

    socket.on('project:check_name',project_check_name)
    socket.on('project:edit',edit_project)
    socket.on('project:get_more_messages',get_more_messages)

    socket.on('new_chat_message',function(data){
      let timestamp = new Date().toISOString()
      scServer.exchange.publish(data.id,{project_id:data.id,timestamp: timestamp,message:data.message,username:socket.getAuthToken().username})
      return db.one('insert into project_messages (project,message,username,timestamp) values ((SELECT name from project where id=$1),$2,$3,$4) returning *',
        [data.id,data.message,socket.getAuthToken().username,timestamp]
      ).then(function(projectMessageDetails){
        console.log('message added : ',projectMessageDetails)
      }).catch(function(err){
        console.log('there was an error: ',err)
      })

    })

    socket.on('update_last_activity',update_last_activity)

    socket.on('user:profile',function(data,res){
      db.one(queries.UserProfile,data.username)
        .then(function(data){
          res(null,user_profile_cleaner(data))
        })
        .catch(function(err){
          console.log('there was an error: ',err)
        })
    })

    socket.on('set_notification',function(data,res){
      return db.any('update account_notifications set unread=false where id = $1',data.id)
                .then(function(){
                  res(null,'ok')
                })
                .catch(function(err){
                  res(err)
                })
    })


    socket.on('user:vote',function(data,res){
      data.voter = socket.getAuthToken().username;
      vote(data)
        .then(function(status){


          notification.call(socket,data,status)
            .then(function(result){
              res(null,status.vote)
            })
            .catch(function(err){
              console.log('there was an error with setting the notification')
              res(null,status.vote) //send message to votee anyway because commend was successfull at least.
            })
          })


        .catch(function(err){
          console.log('there was an error : ',err)
          res('There was an error with the vote')
        })

    })

    socket.on('raw',function(data){
      // console.log('recieved data')
      let pattern = new RegExp('/projects/(\\d+)/((?:[a-zA-Z0-9-_]|%20)+)/messages')
      let match = data.match(pattern)
      if(match){
        // console.log('matches')
        db.one('update account_projects SET last_activity=Now() where project=(SELECT name from project where id=$1) AND username=$2 returning *',
          [parseInt(match[1]),socket.getAuthToken().username]
        ).then(function(data){
          // console.log('user last_activity logged:',data)
        }).catch(function(err){
          console.log('error: ',err)
        })
      }
    })
  })

}
