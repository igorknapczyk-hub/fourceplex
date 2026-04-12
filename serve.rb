Dir.chdir(File.dirname(__FILE__))
require 'webrick'
server = WEBrick::HTTPServer.new(Port: 5678, DocumentRoot: Dir.pwd)
trap('INT') { server.shutdown }
server.start
